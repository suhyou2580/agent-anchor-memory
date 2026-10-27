import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCandidates, resolveRelativeTime, extractAnchorTokens, anchorsForCandidate, privacyGate } from '../../src/extractor.js';
import { validateConfig } from '../../src/config.js';

const NOW = new Date('2026-10-19T10:00:00+08:00'); // 周一

test('计划：打算/计划 抽成 plan，状态为 planned 而不是 confirmed', () => {
  const { candidates } = extractCandidates('我下周三要去成都出差', { now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].memoryType, 'plan');
  assert.equal(candidates[0].payload.status, 'planned');
  assert.equal(candidates[0].when, '2026-10-28');
  assert.equal(candidates[0].payload.object, '成都');
});

test('"考虑" 不能抽成"已决定"', () => {
  const considering = extractCandidates('我在考虑要不要去成都玩', { now: NOW }).candidates[0];
  assert.equal(considering.payload.status, 'considering');
  const decided = extractCandidates('我决定下周三去成都', { now: NOW }).candidates[0];
  assert.equal(decided.payload.status, 'confirmed');
});

test('取消句抽成 cancelled，而不是仍然 planned', () => {
  const { candidates } = extractCandidates('我不去成都了，出差取消了', { now: NOW });
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].payload.status, 'cancelled');
});

test('偏好抽取：喜欢/讨厌 -> preference，core 层', () => {
  const { candidates } = extractCandidates('我讨厌香菜', { now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].memoryType, 'preference');
  assert.equal(candidates[0].tier, 'core');
  assert.equal(candidates[0].payload.object, '香菜');
});

test('疑问句不写记忆', () => {
  const result = extractCandidates('你喜欢吃香菜吗？', { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((item) => item.reason === 'question_not_a_memory'));
});

test('无记忆句式的闲聊不写记忆', () => {
  const result = extractCandidates('今天天气不错啊哈哈哈哈', { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((item) => item.reason === 'no_memory_pattern'));
});

test('显式"记住"指令优先，且 tier=core', () => {
  const { candidates } = extractCandidates('记住：我的生日是十月二十五号', { now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].explicit, true);
  assert.equal(candidates[0].tier, 'core');
  assert.ok(candidates[0].confidence >= 0.9);
});

test('显式"记住"但内容为空时不写', () => {
  const result = extractCandidates('记住', { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((item) => item.reason === 'remember_without_content'));
});

test('凭据类内容被硬拒绝', () => {
  const result = extractCandidates('记住我的密码是 hunter2abc', { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((item) => item.reason === 'forbidden_credential'));
});

test('Agent 自行生成的内容置信度封顶，只能进 pending', () => {
  const { candidates } = extractCandidates('我打算下周三去成都', { now: NOW, sourceType: 'agent_generated' });
  assert.ok(candidates[0].confidence < 0.5);
});

test('相对时间换算：只做确定性换算，不猜', () => {
  assert.equal(resolveRelativeTime('明天见面', NOW).value, '2026-10-20');
  assert.equal(resolveRelativeTime('后天', NOW).value, '2026-10-21');
  assert.equal(resolveRelativeTime('下周三', NOW).value, '2026-10-28');
  assert.equal(resolveRelativeTime('2026-12-01 出发', NOW).value, '2026-12-01');
  assert.equal(resolveRelativeTime('12月1号', NOW).value, '2026-12-01');
  assert.equal(resolveRelativeTime('找个时间吧', NOW), null);
});

test('锚点只取短语级，不产生 2 字滑窗噪声', () => {
  const tokens = extractAnchorTokens('我下周三要去成都出差，计划十月二十五号出发');
  assert.ok(tokens.includes('我下周三要去成都出差'));
  assert.ok(!tokens.includes('三要'));
  assert.ok(!tokens.includes('都出'));
  assert.ok(tokens.every((token) => token.length >= 2 && token.length <= 12));
});

test('实体类锚点来自 object 槽位（短语级切片之外的补充）', () => {
  const [candidate] = extractCandidates('我下周三要去成都出差', { now: NOW }).candidates;
  const tokens = anchorsForCandidate(candidate).map((anchor) => anchor.token);
  assert.ok(tokens.includes('成都'), `应含实体锚点"成都"，实际：${tokens.join(',')}`);
});

test('锚点生成包含槽位锚点且不带分类标签', () => {
  const [candidate] = extractCandidates('记住：我讨厌香菜', { now: NOW }).candidates;
  const anchors = anchorsForCandidate(candidate);
  const tokens = anchors.map((anchor) => anchor.token);
  assert.ok(tokens.includes('香菜'));
  assert.ok(!tokens.includes('preference'), '记忆类型不是锚点');
  assert.ok(anchors.every((anchor) => anchor.token.length >= 2));
});

test('隐私闸门：restricted 拒绝，sensitive 默认拒绝，显式开启后放行', () => {
  const cfg = validateConfig({});
  assert.equal(privacyGate({ sensitivity: 'restricted' }, cfg).allow, false);
  assert.equal(privacyGate({ sensitivity: 'sensitive' }, cfg).allow, false);
  const permissive = validateConfig({ privacy: { storeSensitiveByDefault: true } });
  assert.equal(privacyGate({ sensitivity: 'sensitive' }, permissive).allow, true);
});

test('超长消息被拒绝（不落库）', () => {
  const result = extractCandidates('我打算'.concat('啊'.repeat(3000)), { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((item) => item.reason === 'too_long'));
});
