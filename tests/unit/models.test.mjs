import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSlots,
  classifySensitivity,
  normalizeWhen,
  randomId,
  newNodeId,
  assertEnum,
  MEMORY_TYPES,
  STATUS_VALUES,
  fingerprint,
} from '../../src/models.js';

test('槽位校验：合法槽位通过并被归一化', () => {
  const result = validateSlots({
    subject: '主人',
    action: 'travel',
    object: '成都',
    when: '2026-10-28',
    status: 'planned',
    source_type: 'user_explicit',
    extra_key_should_drop: 'x',
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.status, 'planned');
  assert.equal(result.payload.when, '2026-10-28');
  assert.equal(result.payload.extra_key_should_drop, undefined);
});

test('槽位校验：非法枚举与非法时间必须报错，不能写库', () => {
  const bad = validateSlots({ status: '决定去', subject: '主人' });
  assert.equal(bad.ok, false);
  assert.equal(bad.payload, null);
  assert.ok(bad.errors.some((error) => error.includes('status')));

  const badWhen = validateSlots({ when: '下周三', subject: '主人' });
  assert.equal(badWhen.ok, false);
  assert.ok(badWhen.errors.some((error) => error.includes('when')));
});

test('槽位校验：空对象与超长字段被拒绝', () => {
  assert.equal(validateSlots({}).ok, false);
  const tooLong = validateSlots({ subject: '主'.repeat(300) });
  assert.equal(tooLong.ok, false);
});

test('normalizeWhen 只接受绝对时间', () => {
  assert.deepEqual(normalizeWhen('2026-10-28'), { kind: 'date', value: '2026-10-28' });
  assert.equal(normalizeWhen('2026-10-28T10:00:00Z').kind, 'datetime');
  assert.equal(normalizeWhen('下周'), null);
  assert.equal(normalizeWhen(''), null);
});

test('敏感信息：凭据类一律 forbidden', () => {
  for (const text of ['我的密码是 hunter2abc', 'api_key: sk-abcdefghijklmnop1234', '身份证 110101199003071234']) {
    const result = classifySensitivity(text);
    assert.equal(result.forbidden, true, `应判定为禁止写入：${text}`);
    assert.equal(result.sensitivity, 'restricted');
  }
});

test('敏感信息：隐私类别标记为 sensitive 而非 forbidden', () => {
  const health = classifySensitivity('我最近血压有点高，在吃降压药');
  assert.equal(health.sensitivity, 'sensitive');
  assert.equal(health.forbidden, false);
  assert.equal(classifySensitivity('周报写完了，明天继续').sensitivity, 'normal');
});

test('ID 不可猜测：随机且带前缀，两次不重复', () => {
  const a = newNodeId();
  const b = newNodeId();
  assert.notEqual(a, b);
  assert.match(a, /^M_[a-z0-9]{16}$/);
  assert.match(randomId('X', 8), /^X_[a-z0-9]{8}$/);
});

test('HMAC 指纹需要密钥且可复现，不同密钥结果不同', () => {
  const a = fingerprint('k1', 'same-value');
  const b = fingerprint('k1', 'same-value');
  const c = fingerprint('k2', 'same-value');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
  assert.throws(() => fingerprint('', 'x'), /密钥/);
});

test('assertEnum 拒绝非法值', () => {
  assert.equal(assertEnum('core', ['core', 'normal'], 'tier'), 'core');
  assert.throws(() => assertEnum('huge', ['core', 'normal'], 'tier'), /tier/);
  assert.ok(MEMORY_TYPES.includes('preference'));
  assert.ok(STATUS_VALUES.includes('considering'));
  assert.ok(STATUS_VALUES.includes('cancelled'));
});
