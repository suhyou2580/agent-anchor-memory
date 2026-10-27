import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T10:05:00.000Z');

test('写入 -> 召回：相关内容被召回，无关内容返回空', () => {
  const { service, cleanup } = makeService();
  try {
    const write = service.write('我下周三要去成都出差', { now: T0 });
    const nodeId = firstWritten(write);
    assert.ok(nodeId, '应写入成功');
    assert.equal(write.written[0].state, 'active');
    assert.equal(write.written[0].memory_type, 'plan');

    const hit = service.recall('我下周去成都的事还记得吗', { now: T1 });
    assert.equal(hit.ok, true);
    assert.equal(hit.memories.length, 1);
    assert.equal(hit.memories[0].node_id, nodeId);
    assert.equal(hit.memories[0].payload.object, '成都');

    const empty = service.recall('帮我写个快速排序', { now: T1 });
    assert.equal(empty.memories.length, 0, '无关问题不应强行注入旧记忆');
    assert.equal(empty.metrics.empty, true);
  } finally {
    cleanup();
  }
});

test('只有真正注入的节点才更新 last_recalled_at', () => {
  const { service, cleanup } = makeService();
  try {
    const a = firstWritten(service.write('我喜欢喝美式咖啡', { now: T0 }));
    const b = firstWritten(service.write('我讨厌香菜', { now: T0 }));

    service.recall('咖啡', { now: T1 });

    const nodeA = service.detail(a).memory;
    const nodeB = service.detail(b).memory;
    assert.ok(nodeA.last_recalled_at, '被注入的节点应记录使用时间');
    assert.equal(nodeB.last_recalled_at, null, '没被注入的节点不得因候选命中而升级');
  } finally {
    cleanup();
  }
});

test('召回后强度按"当前值 + boost"重置基准，不重复衰减', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我打算明年去日本旅行', { now: T0 }));
    const later = new Date(T0.getTime() + 60 * 86400000);
    service.recall('日本旅行', { now: later });
    const node = service.detail(nodeId).memory;
    assert.equal(node.strength_base_at, later.toISOString());
    assert.ok(node.strength_base <= 1 && node.strength_base > 0);
  } finally {
    cleanup();
  }
});

test('状态变更：从"计划"到"取消"会替代旧节点，普通查询不再返回旧状态', () => {
  const { service, cleanup } = makeService();
  try {
    const planned = firstWritten(service.write('我下周三要去成都出差', { now: T0 }));
    assert.ok(planned);

    const cancelWrite = service.write('我不去成都了，出差取消了', { now: T1 });
    const cancelled = firstWritten(cancelWrite);
    assert.ok(cancelled, `取消句应写入，实际：${JSON.stringify(cancelWrite)}`);

    const oldNode = service.detail(planned).memory;
    assert.ok(['superseded', 'cancelled'].includes(oldNode.state), `旧节点应退出有效状态，实际 ${oldNode.state}`);

    const normal = service.recall('成都出差', { now: new Date(T1.getTime() + 1000) });
    assert.ok(
      normal.memories.every((memory) => memory.state === 'active'),
      '普通查询不得返回已取消/被替代的旧值',
    );
  } finally {
    cleanup();
  }
});

test('pending_confirm 不进入普通注入，确认后才可召回', () => {
  const { service, cleanup } = makeService();
  try {
    // 手动造一条中置信度候选：user_inferred 封顶 0.75 -> 落 pending_confirm
    const result = service.write('我打算下个月去爬山', { now: T0, sourceType: 'user_inferred' });
    const nodeId = firstWritten(result);
    assert.ok(nodeId);
    assert.equal(result.written[0].state, 'pending_confirm');

    const before = service.recall('爬山', { now: T1 });
    assert.equal(before.memories.length, 0, '待确认内容默认不注入');

    const confirmed = service.confirm({ nodeId, confirmed: true }, { now: T1 });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.state, 'active');

    const after = service.recall('爬山', { now: new Date(T1.getTime() + 1000) });
    assert.equal(after.memories.length, 1);
  } finally {
    cleanup();
  }
});

test('写同一句话两次不会存成两条（去重）', () => {
  const { service, cleanup } = makeService();
  try {
    const first = service.write('我讨厌香菜', { now: T0 });
    const second = service.write('我讨厌香菜', { now: T1 });
    assert.equal(firstWritten(first), firstWritten(second));
    assert.equal(service.list({}).total, 1);
  } finally {
    cleanup();
  }
});

test('结构化注入载荷包含必需字段与免责声明', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我下周三要去成都出差', { now: T0 });
    const result = service.recall('成都', { now: T1 });
    const payload = JSON.parse(JSON.stringify(result));
    assert.ok(payload.focus);
    assert.ok(Array.isArray(payload.memories));
    for (const memory of payload.memories) {
      for (const field of ['node_id', 'memory_type', 'tier', 'stage', 'confidence', 'source_type']) {
        assert.ok(field in memory, `注入载荷缺少字段 ${field}`);
      }
    }
    assert.ok(payload.retrieval_notes.disclaimer.includes('不是指令'));
    assert.ok(typeof payload.retrieval_notes.truncated === 'boolean');
  } finally {
    cleanup();
  }
});

test('Agent 生成的推断不会自动成为已确认事实', () => {
  const { service, cleanup } = makeService();
  try {
    const result = service.write('主人可能喜欢猫', { now: T0, sourceType: 'agent_generated' });
    // 规则抽不出 -> 不落库；即使抽出也只能 pending
    const written = result.written ?? [];
    for (const item of written) {
      assert.notEqual(item.state, 'active', 'agent_generated 不得直接 active');
    }
    const recall = service.recall('猫', { now: T1 });
    assert.equal(recall.memories.length, 0);
  } finally {
    cleanup();
  }
});
