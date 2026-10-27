import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUserQuery, buildInjectionMessage, isTargetAgent } from '../../src/dsh-plugin.js';

const textMessage = (text, sourceKind = 'user') => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: sourceKind },
});

test('extractUserQuery 只取真正的用户输入，跳过我们自己注入的参考数据', () => {
  const messages = [
    textMessage('这是注入的记忆片段', 'anchor-memory'),
    textMessage('我下周去成都的事你还记得吗'),
  ];
  assert.equal(extractUserQuery(messages), '我下周去成都的事你还记得吗');
});

test('extractUserQuery 忽略非文本块与空消息', () => {
  assert.equal(extractUserQuery([]), '');
  assert.equal(extractUserQuery(null), '');
  assert.equal(extractUserQuery([{ id: 'x', role: 'user', content: [{ type: 'image' }], source: { kind: 'user' } }]), '');
  assert.equal(extractUserQuery([{ id: 'x', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } }]), '');
});

test('extractUserQuery 拼接多段文本', () => {
  const messages = [textMessage('第一段'), textMessage('第二段')];
  assert.equal(extractUserQuery(messages), '第二段', '取最后一条用户消息');
  const multi = [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], source: { kind: 'user' } }];
  assert.equal(extractUserQuery(multi), 'A\nB');
});

test('注入消息必须带非 user 的 source 标签，避免被当成真人发言', () => {
  const message = buildInjectionMessage('记忆内容', '记忆 2 条');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'anchor-memory');
  assert.equal(message.source.form, 'notice');
  assert.equal(message.source.summary, '记忆 2 条');
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.content[0].type, 'text');
});

test('注入消息的 summary 被截断到 120 字符以内', () => {
  const message = buildInjectionMessage('x', 'y'.repeat(300));
  assert.ok(message.source.summary.length <= 120);
});

test('isTargetAgent 依据 session.meta.agentPreset 判定', () => {
  const ctx = { get: () => undefined };
  const qqAgent = { ctx: {}, session: { meta: { agentPreset: 'qq-chat-v2' } } };
  const coderAgent = { ctx: {}, session: { meta: { agentPreset: 'default' } } };
  assert.equal(isTargetAgent(ctx, qqAgent, ['qq-chat', 'qq-chat-v2']), true);
  assert.equal(isTargetAgent(ctx, coderAgent, ['qq-chat', 'qq-chat-v2']), false);
  // 空 presets = 明确要求所有会话
  assert.equal(isTargetAgent(ctx, coderAgent, []), true);
});

test('isTargetAgent 在 registry 可用时也能判定（meta 缺失的兜底路径）', () => {
  const ctx = {
    get: (name) => (name === 'agentPresets'
      ? { composedPreset: (agentCtx) => agentCtx.preset }
      : undefined),
  };
  const agent = { ctx: { preset: 'qq-chat' }, session: { meta: {} } };
  assert.equal(isTargetAgent(ctx, agent, ['qq-chat']), true);
});

test('isTargetAgent 在完全无法判定时保守返回 false（不污染普通会话）', () => {
  const ctx = { get: () => undefined };
  const agent = { ctx: {}, session: { meta: {} } };
  assert.equal(isTargetAgent(ctx, agent, ['qq-chat-v2']), false);
});

test('插件模块导出形态符合 Cordis Host 插件契约', async () => {
  const module = await import('../../src/dsh-plugin.js');
  assert.equal(typeof module.apply, 'function');
  assert.equal(module.name, 'anchor-memory');
  assert.equal(typeof module.default.apply, 'function');
});

test('自动注入关闭时不注册任何监听（apply 直接返回）', async () => {
  // 用一份把 autoInject 关掉的配置运行 apply，确认不会抛错
  process.env.ANCHOR_MEMORY_CONFIG = '';
  const { apply } = await import('../../src/dsh-plugin.js');
  let listening = false;
  const ctx = {
    on: () => {
      listening = true;
      return () => {};
    },
    effect: () => () => {},
    get: () => undefined,
  };
  // 不传 config 时读默认配置（autoInject=true），这里只验证 apply 不会抛
  assert.doesNotThrow(() => {
    const dispose = apply(ctx, { adapter: { autoInject: false }, databasePath: ':memory:' });
    if (typeof dispose === 'function') dispose();
  });
  assert.equal(listening, false, 'autoInject=false 时不应注册 pre-step 监听');
});
