import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';

const DAY = 86400000;
const BASE = new Date('2026-01-01T00:00:00.000Z');
const at = (days) => new Date(BASE.getTime() + days * DAY);

test('200 天承诺：非删除记忆在 0/7/30/90/199/200/400 天都不会仅因年龄被物理删除', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我喜欢喝美式咖啡', { now: BASE }));
    for (const days of [0, 7, 30, 90, 199, 200, 400]) {
      const now = at(days);
      const daily = service.daily({ now });
      assert.equal(daily.ok, true, `第 ${days} 天维护失败：${JSON.stringify(daily)}`);
      const node = service.detail(nodeId);
      assert.ok(node.ok, `第 ${days} 天节点必须仍然存在`);
      assert.notEqual(node.memory.state, 'deleted', `第 ${days} 天不得因年龄被删除`);
      assert.ok(node.memory.canonical_text, `第 ${days} 天正文不得被清空`);
    }
    // 明确锚点/关键词查询在 200 天后仍然可取回
    const recalled = service.recall('美式咖啡', { now: at(200) });
    assert.equal(recalled.memories.length, 1, '第 200 天仍应能通过锚点检索取回');
  } finally {
    cleanup();
  }
});

test('阶段降级每轮最多降一级，且不会销毁原始结构化内容', () => {
  const { service, cleanup } = makeService();
  try {
    // 用 normal 层的事实类记忆（偏好会自动进 core，有独立的 365 天宽限）
    const nodeId = firstWritten(service.write('我在杭州上班', { now: BASE }));
    assert.equal(service.detail(nodeId).memory.stage, 'full');
    assert.equal(service.detail(nodeId).memory.tier, 'normal');

    // 超过 full->summary 阈值（30 天）
    service.daily({ now: at(31) });
    assert.equal(service.detail(nodeId).memory.stage, 'summary', '一轮只降一级');

    // summary->keyword 的阈值是 90 天，所以 32 天时不应再降
    service.daily({ now: at(32) });
    assert.equal(service.detail(nodeId).memory.stage, 'summary', '未到下一级阈值不得跨级下降');

    service.daily({ now: at(91) });
    assert.equal(service.detail(nodeId).memory.stage, 'keyword', '到阈值后降一级');

    // 原始 payload 与 canonical_text 不被销毁
    const node = service.detail(nodeId).memory;
    assert.ok(node.canonical_text.includes('杭州'));
    assert.ok(node.payload.subject === '主人');
  } finally {
    cleanup();
  }
});

test('core 层有独立宽限时间，不会和普通记忆一起降级', () => {
  const { service, cleanup } = makeService();
  try {
    const coreId = firstWritten(service.write('记住：我讨厌香菜', { now: BASE }));
    assert.equal(service.detail(coreId).memory.tier, 'core');
    service.daily({ now: at(31) });
    assert.equal(service.detail(coreId).memory.stage, 'full', 'core 在宽限期内不应降级');
  } finally {
    cleanup();
  }
});

test('有效期到点后标记 expired 但保留内容，可按历史查询取回', () => {
  const { service, cleanup } = makeService();
  try {
    // 明确带日期的一次性计划
    const nodeId = firstWritten(service.write('我下周三要去成都出差', { now: BASE }));
    const node = service.detail(nodeId).memory;
    assert.ok(node.valid_until, '带日期的计划必须有 valid_until');

    const afterEvent = new Date(new Date(node.valid_until).getTime() + 2 * DAY);
    const daily = service.daily({ now: afterEvent });
    assert.equal(daily.ok, true);
    const expired = service.detail(nodeId).memory;
    assert.equal(expired.state, 'expired');
    assert.ok(expired.canonical_text, '过期不等于物理删除');

    const normal = service.recall('成都出差', { now: afterEvent });
    assert.equal(normal.memories.length, 0, '过期计划退出普通查询');

    const historical = service.recall('成都出差', { now: afterEvent, includeHistorical: true });
    assert.equal(historical.memories.length, 1, '历史查询可以看到过期记录');
  } finally {
    cleanup();
  }
});

test('维护任务有运行锁，重复触发时第二次直接跳过', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我喜欢喝美式咖啡', { now: BASE });
    // 手工持锁，模拟另一个任务正在跑
    service.handle.db
      .prepare('INSERT INTO task_locks (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('daily:qq:test', 'other', at(0).toISOString(), at(1).toISOString());
    const result = service.daily({ now: at(0) });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'locked');
  } finally {
    cleanup();
  }
});

test('维护任务记录运行结果（可观测）', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我喜欢喝美式咖啡', { now: BASE });
    service.daily({ now: at(31) });
    const runs = service.handle.db.prepare('SELECT * FROM maintenance_runs').all();
    assert.ok(runs.length >= 1);
    assert.ok(runs[0].finished_at);
    assert.equal(runs[0].error_code, null);
  } finally {
    cleanup();
  }
});

test('索引一致性检查与重建可用', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我喜欢喝美式咖啡', { now: BASE });
    service.write('我讨厌香菜', { now: BASE });
    const before = service.integrity();
    assert.equal(before.orphan_node_anchors, 0);
    assert.equal(before.orphan_edges, 0);
    assert.equal(before.fts_missing, 0);

    // 人为破坏索引后重建
    service.handle.db.exec('DELETE FROM memory_fts');
    const broken = service.integrity();
    assert.ok(broken.fts_missing > 0);
    const rebuilt = service.rebuildIndex();
    assert.equal(rebuilt.rebuilt, 2);
    assert.equal(service.integrity().fts_missing, 0);
  } finally {
    cleanup();
  }
});

test('清理候选只列清单，绝不自动删除', () => {
  const { service, cleanup } = makeService();
  try {
    // 用无日期的事实类记忆：带日期的计划会在到期后变成 expired，不进清理候选
    const nodeId = firstWritten(service.write('我在杭州上班', { now: BASE }));
    service.daily({ now: at(300) });
    const candidates = service.cleanupCandidates({ now: at(300) });
    assert.ok(candidates.candidates.some((item) => item.node_id === nodeId), '超过保留期应进入候选清单');
    assert.ok(service.detail(nodeId).ok, '但它绝不能被自动删除');
    assert.notEqual(service.detail(nodeId).memory.state, 'deleted');
  } finally {
    cleanup();
  }
});

test('周度指标可产出（无数据时返回 null 而不是编造 0）', () => {
  const { service, cleanup } = makeService();
  try {
    const empty = service.weekly({ days: 7 });
    assert.equal(empty.recall_calls, 0);
    assert.equal(empty.empty_recall_rate, null);

    service.write('我喜欢喝美式咖啡', { now: BASE });
    service.recall('咖啡', { now: BASE });
    service.recall('完全无关的话题', { now: BASE });
    const metrics = service.weekly({ now: BASE, days: 1 });
    assert.equal(metrics.recall_calls, 2);
    assert.equal(metrics.empty_recall_rate, 0.5);
    assert.ok(metrics.p95_latency_ms >= 0);
    assert.equal(metrics.delete_failures, 0);
  } finally {
    cleanup();
  }
});
