import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, resolveMemoryBudget, DEFAULT_CONFIG, resolveDatabasePath } from '../../src/config.js';

test('默认配置通过校验且关键默认值符合计划书', () => {
  const cfg = validateConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.storage, 'sqlite');
  assert.equal(cfg.recall.topK, 8);
  assert.equal(cfg.recall.maxHops, 1);
  assert.equal(cfg.recall.memoryContextBudgetRatio, 0.12);
  assert.equal(cfg.recall.maxMemoryTokens, 2000);
  assert.equal(cfg.confidence.activeWriteThreshold, 0.8);
  assert.equal(cfg.confidence.pendingThreshold, 0.5);
  assert.equal(cfg.retention.minimumNonDeletedRecallDays, 200);
  assert.equal(cfg.retention.coreAutoPhysicalDelete, false);
  assert.equal(cfg.privacy.storeRawMessages, false);
  assert.equal(cfg.strength.core.tauDays, 365);
  assert.equal(cfg.strength.edge.alpha, 1.8);
});

test('预算比例越界、类型错误、枚举错误都会被拒绝', () => {
  assert.throws(() => validateConfig({ recall: { memoryContextBudgetRatio: 0 } }), /memoryContextBudgetRatio/);
  assert.throws(() => validateConfig({ recall: { memoryContextBudgetRatio: 0.9 } }), /memoryContextBudgetRatio/);
  assert.throws(() => validateConfig({ recall: { topK: 0 } }), /topK/);
  assert.throws(() => validateConfig({ recall: { topK: 'x' } }), /topK/);
  assert.throws(() => validateConfig({ storage: 'postgres' }), /storage/);
  assert.throws(() => validateConfig({ recall: { vectorSearchEnabled: 'yes' } }), /vectorSearchEnabled/);
  assert.throws(() => validateConfig({ confidence: { pendingThreshold: 0.9, activeWriteThreshold: 0.5 } }), /pendingThreshold/);
});

test('默认作用域必须合法，非法 scope 直接报错', () => {
  assert.throws(() => validateConfig({ defaultScope: '有中文' }), /defaultScope/);
  assert.throws(() => validateConfig({ defaultScope: '' }), /defaultScope/);
  assert.equal(validateConfig({ defaultScope: 'qq:2077884862' }).defaultScope, 'qq:2077884862');
});

test('阶段降级阈值必须严格递增', () => {
  assert.throws(
    () => validateConfig({ lifecycle: { demoteIdleDays: { full: 100, summary: 90, keyword: 120 } } }),
    /demoteIdleDays/,
  );
});

test('M1 阶段明确拒绝 storeRawMessages / logMemoryPayloads', () => {
  assert.throws(() => validateConfig({ privacy: { storeRawMessages: true } }), /storeRawMessages/);
  assert.throws(() => validateConfig({ privacy: { logMemoryPayloads: true } }), /logMemoryPayloads/);
});

test('记忆预算取"比例"与"固定上限"的较小值', () => {
  const cfg = validateConfig({});
  // 128k * 0.12 = 15360 > 2000 上限 ⇒ 用 2000
  assert.equal(resolveMemoryBudget(cfg).budgetTokens, 2000);
  // 小上下文窗口 ⇒ 用比例值，不吃掉主提示词
  assert.equal(resolveMemoryBudget(cfg, 4000).budgetTokens, 480);
  // 极小窗口也不会变成 0 或负数
  assert.equal(resolveMemoryBudget(cfg, 100).budgetTokens, 12);
});

test('配置不会被入参污染，且默认值对象不被修改', () => {
  const raw = { recall: { topK: 3 } };
  const cfg = validateConfig(raw);
  assert.equal(cfg.recall.topK, 3);
  assert.equal(DEFAULT_CONFIG.recall.topK, 8);
  assert.equal(raw.recall.topK, 3);
});

test('相对路径按 baseDir 解析，:memory: 原样保留', () => {
  const cfg = validateConfig({ databasePath: 'data/x.db' });
  const resolved = resolveDatabasePath(cfg, 'D:/base');
  assert.match(resolved, /data[\\/]x\.db$/);
  assert.equal(resolveDatabasePath(validateConfig({ databasePath: ':memory:' }), 'D:/base'), ':memory:');
});
