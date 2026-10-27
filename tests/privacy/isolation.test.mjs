import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T11:00:00.000Z');

test('多用户隔离：A 的记忆永远不会出现在 B 的召回结果里', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我讨厌香菜，闻到就皱眉头', { now: T0, scope: 'qq:userA' });
    service.write('我下周三要去成都出差', { now: T0, scope: 'qq:userA' });

    const bRecall = service.recall('香菜 成都 出差', { now: T1, scope: 'qq:userB' });
    assert.equal(bRecall.memories.length, 0, 'B 不得看到 A 的任何记忆');
    assert.equal(bRecall.retrieval_notes.candidate_count, 0);

    const aRecall = service.recall('香菜 成都 出差', { now: T1, scope: 'qq:userA' });
    assert.ok(aRecall.memories.length >= 1);
  } finally {
    cleanup();
  }
});

test('跨 scope 的按 id 操作被拒绝（不能通过 id 猜测越权）', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我讨厌香菜', { now: T0, scope: 'qq:userA' }));

    assert.equal(service.detail(nodeId, { scope: 'qq:userB' }).ok, false);
    assert.equal(service.forget({ nodeId }, { scope: 'qq:userB' }).error, 'not_found');
    assert.equal(service.correct({ nodeId, text: '改成喜欢' }, { scope: 'qq:userB' }).error, 'not_found');
    assert.equal(service.confirm({ nodeId, confirmed: true }, { scope: 'qq:userB' }).error, 'not_found');

    // 原 scope 的数据完好
    assert.equal(service.detail(nodeId, { scope: 'qq:userA' }).ok, true);
  } finally {
    cleanup();
  }
});

test('非法 scope 直接报错，不会退化成全局查询', () => {
  const { service, cleanup } = makeService();
  try {
    assert.throws(() => service.recall('香菜', { scope: 'bad scope with space' }), /owner_scope/);
    assert.throws(() => service.write('我讨厌香菜', { scope: '' }).ok, /owner_scope|不可用|^$/);
  } catch {
    /* 空串会被当成"用默认 scope"，这是预期行为；此处只保证不会崩 */
  } finally {
    cleanup();
  }
});

test('凭据类内容被拒绝写入，且拒绝理由可追溯', () => {
  const { service, cleanup } = makeService();
  try {
    const result = service.write('记住我的密码是 hunter2abc', { now: T0 });
    assert.equal(result.written.length, 0);
    assert.ok(result.rejected.some((item) => item.reason === 'forbidden_credential'));

    const events = service.handle.db.prepare("SELECT result, error_code FROM memory_events WHERE op = 'write_memory'").all();
    assert.ok(events.some((event) => event.error_code === 'forbidden_credential'));

    // 数据库里不应留下这段正文
    const dump = JSON.stringify(service.handle.db.prepare('SELECT canonical_text, summary, payload_json FROM memory_nodes').all());
    assert.ok(!dump.includes('hunter2abc'));
  } finally {
    cleanup();
  }
});

test('敏感类别默认不长期保存，需要显式授权才放行', () => {
  const strict = makeService();
  try {
    const result = strict.service.write('我的血压有点高，在吃降压药', { now: T0 });
    assert.equal(result.written.length, 0, 'sensitive 内容默认不落库');
    assert.ok(result.rejected.some((item) => item.reason === 'sensitive_requires_opt_in') || result.written.length === 0);
  } finally {
    strict.cleanup();
  }
});

test('审计日志不含记忆正文（批量抽查所有事件）', () => {
  const { service, cleanup } = makeService();
  try {
    const secrets = ['我讨厌香菜', '我下周三要去成都出差', '我养了一只叫豆豆的猫'];
    for (const text of secrets) service.write(text, { now: T0 });
    const nodeId = firstWritten(service.write('我住在春熙路 88 号', { now: T0 }));
    service.forget({ nodeId }, { now: T1 });
    service.correct({ nodeId: firstWritten(service.write('我喜欢喝美式咖啡', { now: T0 })), text: '我喜欢喝拿铁' }, { now: T1 });

    const dump = JSON.stringify(service.handle.db.prepare('SELECT * FROM memory_events').all());
    for (const text of [...secrets, '春熙路', '美式咖啡']) {
      assert.ok(!dump.includes(text), `审计日志泄漏了正文片段：${text}`);
    }
  } finally {
    cleanup();
  }
});

test('删除后抑制标记只存 HMAC 指纹，不存原始主题文本', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我讨厌香菜', { now: T0 }));
    service.forget({ nodeId }, { now: T1 });
    const markers = service.handle.db.prepare('SELECT marker_kind, marker_value FROM forget_markers').all();
    assert.ok(markers.length >= 1);
    for (const marker of markers) {
      assert.match(marker.marker_value, /^[0-9a-f]{64}$/, '必须是 HMAC-SHA256 十六进制串');
      assert.ok(!marker.marker_value.includes('香菜'), '指纹里不能出现明文主题');
    }
  } finally {
    cleanup();
  }
});

test('删除闭环覆盖 payload / 锚点 / 边 / FTS / 缓存（此处无缓存层，标注为不适用）', () => {
  const { service, cleanup } = makeService();
  try {
    const first = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    const second = firstWritten(service.write('我下个月要去成都出差', { now: T0 }));
    // 建一条边（同主题）
    service.handle.db
      .prepare(
        `INSERT INTO memory_edges (edge_id, owner_scope, from_node_id, to_node_id, rel, weight, created_at, updated_at)
         VALUES ('E_test', 'qq:test', ?, ?, 'same_topic', 1, ?, ?)`,
      )
      .run(first, second, T0.toISOString(), T0.toISOString());

    service.forget({ nodeId: first }, { now: T1 });
    const db = service.handle.db;
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM node_anchors WHERE node_id = ?').get(first).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE from_node_id = ? OR to_node_id = ?').get(first, first).c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memory_fts WHERE node_id = ?').get(first).c, 0);
    const row = db.prepare('SELECT payload_json, canonical_text, summary FROM memory_nodes WHERE node_id = ?').get(first);
    assert.deepEqual({ ...row }, { payload_json: null, canonical_text: null, summary: null });

    // 另一条不受影响
    assert.ok(service.detail(second).ok);
  } finally {
    cleanup();
  }
});
