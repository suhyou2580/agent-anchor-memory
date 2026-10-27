import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText,
  tokenize,
  tokenText,
  ftsExpression,
  estimateTokens,
  anchorCandidates,
  topicFingerprint,
} from '../../src/tokenize.js';

test('normalizeText 折叠空白并做 NFKC', () => {
  assert.equal(normalizeText('  Hello\u3000World  '), 'hello world');
  assert.equal(normalizeText('ＡＢＣ'), 'abc'); // 全角 -> 半角
});

test('中文按 bigram 切分，并保留尾字以便单字查询', () => {
  assert.deepEqual(tokenize('成都'), ['成都', '都']);
  assert.deepEqual(tokenize('成都旅行'), ['成都', '都旅', '旅行', '行']);
  assert.deepEqual(tokenize('我讨厌香菜'), ['我讨', '讨厌', '厌香', '香菜', '菜']);
  // 单字片段本身就是一个 token
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('2 字中文查询能被 bigram 覆盖（unicode61/trigram 做不到的正是这一档）', () => {
  const indexed = new Set(tokenize('主人想去成都旅行'));
  assert.ok(indexed.has('成都'));
  assert.ok(indexed.has('旅行'));
  // 1 字查询走单字 token
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('中英混排分别切词', () => {
  const tokens = tokenize('用 DeepSeek V3 写代码');
  assert.ok(tokens.includes('deepseek'));
  assert.ok(tokens.includes('v3'));
  assert.ok(tokens.includes('写代'));
  assert.ok(tokens.includes('代码'));
});

test('tokenText 去重，ftsExpression 生成带引号的 OR 表达式', () => {
  assert.equal(tokenText('成都'), '成都 都');
  const expr = ftsExpression('成都 旅行');
  assert.ok(expr.includes('"成都"'));
  assert.ok(expr.includes(' OR '));
  assert.equal(ftsExpression('   '), '');
});

test('ftsExpression 把 FTS5 语法字符当普通文本处理', () => {
  // 引号被当作分隔符剥掉，因此不会出现未闭合引号
  const expr = ftsExpression('a"b');
  assert.ok(!expr.includes('a"b'));
  for (const token of expr.split(' OR ')) {
    assert.match(token, /^"[^"]*"$/);
  }
  // 大写操作符被小写化 + 引号包裹后成为普通 token，不会当作 FTS 语法执行
  const syntax = ftsExpression('AND OR NOT * ( )');
  assert.equal(syntax, '"and" OR "or" OR "not"');
  for (const token of syntax.split(' OR ')) assert.match(token, /^"[^"]*"$/);
});

test('estimateTokens 中文按字、英文按 4 字符估算', () => {
  assert.equal(estimateTokens('成都'), 2);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(estimateTokens('主人要去成都出差') >= 7);
});

test('anchorCandidates 只产出 >=2 字片段并去重', () => {
  const anchors = anchorCandidates('去成都吃火锅');
  assert.ok(anchors.includes('成都'));
  assert.ok(anchors.includes('火锅'));
  assert.ok(anchors.every((token) => token.length >= 2));
  assert.equal(new Set(anchors).size, anchors.length);
});

test('topicFingerprint 与词序无关', () => {
  const a = topicFingerprint(['成都 旅行', 'plan']);
  const b = topicFingerprint(['plan', '旅行 成都']);
  assert.equal(a, b);
});
