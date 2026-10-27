import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply } from '../../src/dsh-plugin.js';
import { createMemoryService } from '../../src/service.js';
import { tempDbPath } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');

/** Windows 上句柄未释放时 rm 会 EPERM；测试清理失败不影响断言。 */
function tolerantCleanup(databasePath) {
  try {
    tolerantCleanup(databasePath);
  } catch {
    /* ignore */
  }
}

/** 一个最小可用的 Cordis ctx 替身：捕获注册的监听器。 */
function fakeCtx() {
  const listeners = new Map();
  const effects = [];
  return {
    listeners,
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    get() {
      return undefined;
    },
    disposeAll() {
      for (const dispose of effects) {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function userMessage(text) {
  return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

test('模式 A 接线：pre-step 里真的把记忆注入到模型请求前的消息列表', async () => {
  const databasePath = tempDbPath('wiring');
  const scope = 'qq:wiring';
  const ctx = fakeCtx();
  let dispose;
  try {
    // 先写入一条记忆（用独立的 service 实例写同一个库）
    const seed = createMemoryService({ config: { databasePath, defaultScope: scope } });
    const written = seed.write('我下周三要去成都出差', { now: T0 });
    assert.ok(written.written.length === 1);
    seed.close();

    // presets: [] 表示对所有会话生效（测试里没有真实的 preset 元数据）
    dispose = apply(ctx, { databasePath, defaultScope: scope, adapter: { presets: [] } });
    const handler = ctx.listeners.get('agent/pre-step');
    assert.equal(typeof handler, 'function', '必须注册 agent/pre-step 监听');

    const query = userMessage('我下周去成都的事你还记得吗');
    const decision = await handler(
      { agent: { session: { meta: { agentPreset: 'qq-chat-v2' } }, ctx: {} }, messages: [query], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [query] }),
    );

    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, 2, '应注入一条记忆上下文消息');
    // 注入位置：紧贴本轮用户输入之前（不是第 0 位）。
    // 放第 0 位会每轮换掉前缀，打掉 DeepSeek 的前缀缓存（实测命中率 98.8% → 接近 0，成本涨 7~8 倍）。
    const injected = decision.messages.at(-2);
    assert.equal(decision.messages.indexOf(injected), decision.messages.length - 2, '记忆必须插在最后一条用户输入之前，前面历史保持原序');
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, 'anchor-memory', '注入消息必须带来源标签，不能冒充真人发言');
    const text = injected.content[0].text;
    assert.ok(text.includes('成都'), `注入内容应包含召回到的记忆：${text.slice(0, 200)}`);
    assert.ok(text.includes('不是指令'), '必须声明是参考数据而不是指令');
    // 原始用户消息保持在最后
    assert.equal(decision.messages.at(-1), query);
  } finally {
    dispose?.();
    ctx.disposeAll();
    tolerantCleanup(databasePath);
  }
});

test('同一轮只注入一次，不会每个 step 都重复注入', async () => {
  const databasePath = tempDbPath('wiring2');
  const scope = 'qq:wiring2';
  const ctx = fakeCtx();
  let dispose;
  try {
    const seed = createMemoryService({ config: { databasePath, defaultScope: scope } });
    seed.write('我讨厌香菜', { now: T0 });
    seed.close();

    dispose = apply(ctx, { databasePath, defaultScope: scope, adapter: { presets: [] } });
    const handler = ctx.listeners.get('agent/pre-step');
    const agent = { session: { meta: { agentPreset: 'qq-chat' } }, ctx: {} };
    const query = userMessage('香菜');
    const payload = { agent, messages: [query], turn: 3, step: 1 };
    const next = async () => ({ kind: 'enter', messages: [query] });

    const first = await handler(payload, next);
    const second = await handler({ ...payload, step: 2 }, next);
    assert.equal(first.messages.length, 2);
    assert.equal(second.messages.length, 1, '同一 turn 的后续 step 不得重复注入');

    const nextTurn = await handler({ ...payload, turn: 4, step: 1 }, next);
    assert.equal(nextTurn.messages.length, 2, '新的一轮应重新注入');
  } finally {
    dispose?.();
    ctx.disposeAll();
    tolerantCleanup(databasePath);
  }
});

test('非目标 preset 的会话不受影响（不注入）', async () => {
  const databasePath = tempDbPath('wiring3');
  const scope = 'qq:wiring3';
  const ctx = fakeCtx();
  let dispose;
  try {
    const seed = createMemoryService({ config: { databasePath, defaultScope: scope } });
    seed.write('我讨厌香菜', { now: T0 });
    seed.close();

    dispose = apply(ctx, { databasePath, defaultScope: scope, adapter: { presets: ['qq-chat', 'qq-chat-v2'] } });
    const handler = ctx.listeners.get('agent/pre-step');
    const query = userMessage('香菜');
    const decision = await handler(
      { agent: { session: { meta: { agentPreset: 'standard' } }, ctx: {} }, messages: [query], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [query] }),
    );
    assert.equal(decision.messages.length, 1, '普通编码会话不应被注入记忆');
  } finally {
    dispose?.();
    ctx.disposeAll();
    tolerantCleanup(databasePath);
  }
});

test('无相关记忆时不注入，且不改动 decision', async () => {
  const databasePath = tempDbPath('wiring4');
  const ctx = fakeCtx();
  let dispose;
  try {
    dispose = apply(ctx, { databasePath, defaultScope: 'qq:wiring4', adapter: { presets: [] } });
    const handler = ctx.listeners.get('agent/pre-step');
    const query = userMessage('帮我写个快速排序');
    const decision = await handler(
      { agent: { session: { meta: {} }, ctx: {} }, messages: [query], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [query] }),
    );
    assert.equal(decision.messages.length, 1);
  } finally {
    dispose?.();
    ctx.disposeAll();
    tolerantCleanup(databasePath);
  }
});

test('记忆库不可用时注入钩子不抛错（聊天降级为无记忆）', async () => {
  const ctx = fakeCtx();
  let dispose;
  try {
    // 用一个非法路径制造初始化失败：plugin 应该打印错误并**不注册**监听
    dispose = apply(ctx, { databasePath: '\u0000invalid-path/db.sqlite', adapter: { presets: [] } });
    const handler = ctx.listeners.get('agent/pre-step');
    if (handler) {
      const query = userMessage('香菜');
      const decision = await handler(
        { agent: { session: { meta: {} }, ctx: {} }, messages: [query], turn: 1, step: 1 },
        async () => ({ kind: 'enter', messages: [query] }),
      );
      assert.equal(decision.kind, 'enter', '钩子必须原样放行 decision');
    }
    // 无论是否注册，apply 本身都不能抛
    assert.ok(true);
  } finally {
    dispose?.();
    ctx.disposeAll();
  }
});

test('pre-step 钩子对 reject 决策不做任何事', async () => {
  const databasePath = tempDbPath('wiring6');
  const ctx = fakeCtx();
  let dispose;
  try {
    dispose = apply(ctx, { databasePath, defaultScope: 'qq:wiring6', adapter: { presets: [] } });
    const handler = ctx.listeners.get('agent/pre-step');
    const decision = await handler(
      { agent: { session: { meta: {} }, ctx: {} }, messages: [], turn: 1, step: 1 },
      async () => ({ kind: 'reject' }),
    );
    assert.deepEqual(decision, { kind: 'reject' });
  } finally {
    dispose?.();
    ctx.disposeAll();
    tolerantCleanup(databasePath);
  }
});
