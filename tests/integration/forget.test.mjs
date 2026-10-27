import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T11:00:00.000Z');

/** 统计某节点在各处的残留（正文 / 锚点关系 / 关系边 / 全文索引）。 */
function residue(service, nodeId) {
  const db = service.handle.db;
  const node = db.prepare('SELECT * FROM memory_nodes WHERE node_id = ?').get(nodeId);
  // 故意注入故障的用例会把 memory_fts 整表删掉，此时记为 -1（索引不可用）
  let fts = -1;
  try {
    fts = db.prepare('SELECT COUNT(*) AS c FROM memory_fts WHERE node_id = ?').get(nodeId).c;
  } catch {
    fts = -1;
  }
  return {
    exists: Boolean(node),
    state: node?.state ?? null,
    payload_json: node?.payload_json ?? null,
    canonical_text: node?.canonical_text ?? null,
    summary: node?.summary ?? null,
    dedupe_key: node?.dedupe_key ?? null,
    topic_key: node?.topic_key ?? null,
    anchors: db.prepare('SELECT COUNT(*) AS c FROM node_anchors WHERE node_id = ?').get(nodeId).c,
    edges: db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE from_node_id = ? OR to_node_id = ?').get(nodeId, nodeId).c,
    fts,
    purge_pending: node?.purge_pending ?? null,
    deleted_at: node?.deleted_at ?? null,
  };
}

test('删除闭环：正文/锚点关系/边/全文索引全部清理，且召回不再返回', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我下周三要去成都出差，住在春熙路', { now: T0 }));
    assert.ok(nodeId);
    assert.ok(service.recall('成都出差', { now: T1 }).memories.length > 0);

    const result = service.forget({ nodeId }, { now: T1 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'deleted');
    assert.deepEqual(result.stages, ['content', 'node_anchors', 'edges', 'fts', 'forget_marker']);

    const after = residue(service, nodeId);
    assert.equal(after.exists, true, '保留最小墓碑行以便验证删除完成');
    assert.equal(after.state, 'deleted');
    assert.equal(after.payload_json, null, 'payload 必须被清空');
    assert.equal(after.canonical_text, null, 'canonical_text 必须被清空');
    assert.equal(after.summary, null, 'summary 必须被清空');
    assert.equal(after.dedupe_key, null);
    assert.equal(after.topic_key, null);
    assert.equal(after.anchors, 0, '锚点关系必须删除');
    assert.equal(after.edges, 0, '关系边必须删除');
    assert.equal(after.fts, 0, '全文索引条目必须删除');
    assert.equal(after.purge_pending, 0);
    assert.ok(after.deleted_at);

    assert.equal(service.recall('成都出差', { now: new Date(T1.getTime() + 1000) }).memories.length, 0);
  } finally {
    cleanup();
  }
});

test('删除后被删内容不会从同一来源被自动写回（抑制标记）', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我讨厌香菜', { now: T0 }));
    service.forget({ nodeId }, { now: T1 });

    const rewrite = service.write('我讨厌香菜', { now: new Date(T1.getTime() + 1000) });
    assert.equal(rewrite.written.length, 0, '被忘掉的主题不应被同一规则源自动写回');
    assert.ok(rewrite.suppressed.length >= 1);

    // 但主人显式要求重新记住时必须能写回
    const explicit = service.remember({ text: '我讨厌香菜' }, { now: new Date(T1.getTime() + 2000) });
    assert.equal(explicit.ok, true, JSON.stringify(explicit));
  } finally {
    cleanup();
  }
});

test('目标不唯一时只列候选，不批量误删', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我下周三要去成都出差', { now: T0 });
    service.write('我打算十一去成都玩', { now: T0 });

    const result = service.forget({ query: '成都' }, { now: T1 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ambiguous');
    assert.ok(result.candidates.length >= 2);
    assert.equal(service.list({}).total, 2, '歧义查询不得删除任何记忆');
  } finally {
    cleanup();
  }
});

test('删除失败不报告成功，且继续屏蔽召回，可按阶段重试', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));

    // 制造故障：直接删掉全文索引表，让清理阶段的 FTS 删除抛错。
    service.handle.db.exec('DROP TABLE memory_fts');

    const failed = service.forget({ nodeId }, { now: T1 });
    assert.equal(failed.ok, false, '清理失败时绝不能返回成功');
    assert.equal(failed.error, 'purge_failed');
    assert.equal(failed.blocking, true);
    assert.equal(failed.purgePending, true);

    const mid = residue(service, nodeId);
    assert.equal(mid.state, 'deleted', '召回屏蔽必须先生效');
    assert.equal(mid.purge_pending, 1, '未完成清理必须留下可重试标记');
    assert.ok(mid.payload_json !== null, '事务回滚后正文应仍在（此时并未真正清理完成）');

    // 召回必须已被屏蔽（不依赖索引是否清理成功）；索引坏了要降级而不是抛错
    const blocked = service.recall('成都出差', { now: new Date(T1.getTime() + 1000) });
    assert.equal(blocked.ok, true, '索引故障应降级为无记忆，而不是让召回整体失败');
    assert.equal(blocked.memories.length, 0, '清理失败也必须继续屏蔽召回');
    assert.equal(blocked.retrieval_notes.fts_degraded, true, '索引降级必须被明确报告');

    // 故障排除后按 maintenance 重试，才真正完成
    service.handle.db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5 (node_id UNINDEXED, toks, tokenize = 'unicode61')");
    const daily = service.daily({ now: new Date(T1.getTime() + 2000) });
    assert.equal(daily.ok, true);
    const done = residue(service, nodeId);
    assert.equal(done.purge_pending, 0);
    assert.equal(done.payload_json, null);
    assert.equal(done.canonical_text, null);
    assert.equal(done.fts, 0);
  } finally {
    cleanup();
  }
});

test('删除审计里不出现被删正文', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我下周三要去成都出差，住在春熙路', { now: T0 }));
    service.forget({ nodeId }, { now: T1 });

    const events = service.handle.db.prepare('SELECT * FROM memory_events ORDER BY created_at').all();
    const dump = JSON.stringify(events);
    assert.ok(!dump.includes('春熙路'), '审计日志不得包含被删正文');
    assert.ok(!dump.includes('成都'), '审计日志不得包含被删正文');
    assert.ok(events.some((event) => event.op === 'forget_memory' && event.result === 'deleted'));
  } finally {
    cleanup();
  }
});

test('删除不存在的 id 时明确报错而不是静默成功', () => {
  const { service, cleanup } = makeService();
  try {
    const result = service.forget({ nodeId: 'M_not_exist' }, { now: T1 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_found');
  } finally {
    cleanup();
  }
});
