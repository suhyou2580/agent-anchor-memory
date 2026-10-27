import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-20T10:00:00.000Z');
const T2 = new Date('2026-10-21T10:00:00.000Z');

test('纠正后普通查询不再返回旧事实，旧节点标 superseded 并留下版本关系', () => {
  const { service, cleanup } = makeService();
  try {
    const oldId = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    const corrected = service.correct({ nodeId: oldId, text: '我改成下周去重庆出差' }, { now: T1 });
    assert.equal(corrected.ok, true, JSON.stringify(corrected));
    assert.equal(corrected.supersededNodeId, oldId);
    assert.equal(corrected.relation, 'supersedes');

    const oldNode = service.detail(oldId).memory;
    assert.equal(oldNode.state, 'superseded');

    // 版本边存在
    const edges = service.handle.db
      .prepare('SELECT rel FROM memory_edges WHERE from_node_id = ? AND to_node_id = ?')
      .all(corrected.newNodeId, oldId)
      .map((row) => row.rel);
    assert.ok(edges.includes('supersedes'));
    assert.ok(edges.includes('previous_version'));

    // 普通查询只返回新值
    const normal = service.recall('出差', { now: T2 });
    const ids = normal.memories.map((memory) => memory.node_id);
    assert.ok(ids.includes(corrected.newNodeId), `普通查询应返回新节点，实际：${ids.join(',')}`);
    assert.ok(!ids.includes(oldId), '普通查询不得返回已被替代的旧节点');
  } finally {
    cleanup();
  }
});

test('历史查询可以看到被替代的旧值，且状态标注为 superseded', () => {
  const { service, cleanup } = makeService();
  try {
    const oldId = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    const corrected = service.correct({ nodeId: oldId, text: '我改成下周去重庆出差' }, { now: T1 });

    const historical = service.recall('成都出差', { now: T2, includeHistorical: true });
    const found = historical.memories.find((memory) => memory.node_id === oldId);
    assert.ok(found, '历史查询应能取回旧版本');
    assert.equal(found.state, 'superseded');
    assert.ok(historical.memories.some((memory) => memory.node_id === corrected.newNodeId));
  } finally {
    cleanup();
  }
});

test('纠正不存在的节点或空内容时明确报错', () => {
  const { service, cleanup } = makeService();
  try {
    assert.equal(service.correct({ nodeId: 'M_nope', text: '改成别的' }, { now: T1 }).error, 'not_found');
    const id = firstWritten(service.write('我喜欢喝美式咖啡', { now: T0 }));
    assert.equal(service.correct({ nodeId: id, text: '   ' }, { now: T1 }).error, 'empty_text');
  } finally {
    cleanup();
  }
});

test('已删除节点不能被纠正（避免复活）', () => {
  const { service, cleanup } = makeService();
  try {
    const id = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    service.forget({ nodeId: id }, { now: T1 });
    const result = service.correct({ nodeId: id, text: '我改成去重庆' }, { now: T2 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'node_deleted');
  } finally {
    cleanup();
  }
});

test('纠正后的新节点带着正确槽位，且不会被普通规则写回去重', () => {
  const { service, cleanup } = makeService();
  try {
    const oldId = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    const corrected = service.correct({ nodeId: oldId, text: '我改成去重庆出差' }, { now: T1 });
    const node = service.detail(corrected.newNodeId).memory;
    assert.equal(node.state, 'active');
    assert.equal(node.extraction_confidence, 0.95);
    assert.equal(node.supersedes_node_id, oldId);
    assert.ok(node.payload.status === 'confirmed' || node.payload.status === 'planned');
  } finally {
    cleanup();
  }
});
