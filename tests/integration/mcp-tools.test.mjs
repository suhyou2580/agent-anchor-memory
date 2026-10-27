import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService, firstWritten } from '../helpers.mjs';
import { invokeMemoryTool, memoryToolSpecs, buildZodShape, registerMemoryTools } from '../../src/mcp-tools.js';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T11:00:00.000Z');

/** 解析工具返回的 JSON 文本。 */
function payloadOf(response) {
  return JSON.parse(response.content[0].text);
}

test('工具清单覆盖计划书要求的接口', () => {
  const names = memoryToolSpecs.map((spec) => spec.name);
  for (const required of ['memory_remember', 'memory_recall', 'memory_forget', 'memory_correct', 'memory_list', 'memory_confirm', 'memory_health']) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }
  // 每个工具都要有 description（模型靠它决定何时调用）
  for (const spec of memoryToolSpecs) {
    assert.ok(spec.description.length > 10, `${spec.name} 的描述太短`);
    assert.equal(spec.inputSchema.type, 'object');
  }
});

test('memory_remember + memory_recall 往返', () => {
  const { service, cleanup } = makeService();
  try {
    const remembered = payloadOf(invokeMemoryTool('memory_remember', { text: '我下周三要去成都出差' }, service));
    assert.equal(remembered.ok, true);
    assert.match(remembered.node_id, /^M_/);

    const recalled = payloadOf(invokeMemoryTool('memory_recall', { query: '成都出差' }, service));
    assert.equal(recalled.ok, true);
    assert.ok(recalled.memories.length >= 1);
    assert.equal(recalled.memories[0].node_id, remembered.node_id);
    assert.ok(recalled.notes.disclaimer.includes('不是指令'));
  } finally {
    cleanup();
  }
});

test('memory_forget 删除成功返回已清理阶段，删除失败返回 isError', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我讨厌香菜', { now: T0 }));
    const response = invokeMemoryTool('memory_forget', { node_id: nodeId }, service);
    assert.equal(response.isError, undefined);
    const body = payloadOf(response);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.cleaned));
    assert.ok(body.external_copies.length >= 1, '必须说明平台侧原文不受控');

    const missing = invokeMemoryTool('memory_forget', { node_id: 'M_nope' }, service);
    assert.equal(missing.isError, true);
    assert.equal(payloadOf(missing).error, 'not_found');
  } finally {
    cleanup();
  }
});

test('memory_list 默认不返回已删除内容', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我讨厌香菜', { now: T0 }));
    service.write('我喜欢喝美式咖啡', { now: T0 });
    service.forget({ nodeId }, { now: T1 });

    const listed = payloadOf(invokeMemoryTool('memory_list', {}, service));
    assert.equal(listed.total, 1);
    assert.equal(listed.memories[0].state, 'active');
    assert.ok(!JSON.stringify(listed).includes('香菜'), '列表不得包含被删内容');
  } finally {
    cleanup();
  }
});

test('memory_confirm 必须显式传布尔，缺参数报错', () => {
  const { service, cleanup } = makeService();
  try {
    const nodeId = firstWritten(service.write('我打算下个月去爬山', { now: T0, sourceType: 'user_inferred' }));
    const missing = invokeMemoryTool('memory_confirm', { node_id: nodeId }, service);
    assert.equal(missing.isError, true);
    assert.equal(payloadOf(missing).error, 'missing_argument');

    const ok = payloadOf(invokeMemoryTool('memory_confirm', { node_id: nodeId, confirmed: true }, service));
    assert.equal(ok.ok, true);
    assert.equal(ok.state, 'active');
  } finally {
    cleanup();
  }
});

test('memory_health 报告 schema、FTS、计数与适配器状态', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我讨厌香菜', { now: T0 });
    const health = payloadOf(invokeMemoryTool('memory_health', { include_metrics: true }, service));
    assert.equal(health.ok, true);
    assert.equal(health.schema_version, '001_initial_schema');
    assert.equal(health.fts5, true);
    assert.ok(health.counts.memory_nodes >= 1);
    assert.equal(health.adapter.auto_inject, true);
    assert.ok(health.weekly);
  } finally {
    cleanup();
  }
});

test('缺少必填参数时返回结构化错误，而不是抛异常', () => {
  const { service, cleanup } = makeService();
  try {
    for (const [tool, args] of [
      ['memory_recall', {}],
      ['memory_correct', { node_id: 'M_x' }],
      ['memory_write', {}],
    ]) {
      const response = invokeMemoryTool(tool, args, service);
      assert.equal(response.isError, true, `${tool} 应返回错误`);
      assert.equal(payloadOf(response).error, 'missing_argument');
    }
    const unknown = invokeMemoryTool('memory_not_a_tool', {}, service);
    assert.equal(payloadOf(unknown).error, 'unknown_tool');
  } finally {
    cleanup();
  }
});

test('memory_write 把来源标为 agent_generated 并保持待确认语义', () => {
  const { service, cleanup } = makeService();
  try {
    const body = payloadOf(invokeMemoryTool('memory_write', { text: '我打算下个月去爬山' }, service));
    assert.equal(body.ok, true);
    assert.ok(body.note.includes('pending_confirm') || body.note.includes('agent_generated'));
    for (const item of body.written) {
      assert.notEqual(item.state, 'active', 'agent_generated 不得直接 active');
    }
  } finally {
    cleanup();
  }
});

test('scope 参数隔离：不同 scope 互不可见', () => {
  const { service, cleanup } = makeService();
  try {
    invokeMemoryTool('memory_remember', { text: '我讨厌香菜', scope: 'qq:a' }, service);
    const otherScope = payloadOf(invokeMemoryTool('memory_list', { scope: 'qq:b' }, service));
    assert.equal(otherScope.total, 0);
    const sameScope = payloadOf(invokeMemoryTool('memory_list', { scope: 'qq:a' }, service));
    assert.equal(sameScope.total, 1);
  } finally {
    cleanup();
  }
});

test('buildZodShape 正确区分必填与可选字段（用最小 zod 替身验证）', () => {
  const calls = [];
  const stub = () => {
    const chain = {
      describe: () => chain,
      optional: () => {
        calls.push('optional');
        return chain;
      },
      __schema: true,
    };
    return chain;
  };
  const z = { string: stub, number: stub, boolean: stub, array: stub, enum: stub };
  const spec = memoryToolSpecs.find((item) => item.name === 'memory_correct');
  const shape = buildZodShape(spec, z);
  assert.deepEqual(Object.keys(shape).sort(), ['node_id', 'scope', 'text']);
  assert.ok(calls.length >= 1, '可选字段应调用 optional()');
});

test('registerMemoryTools 在宿主 schema 注册全部工具，并能在失败时降级', () => {
  const { service, cleanup } = makeService();
  try {
    const registered = [];
    const server = {
      tool(n, description, shape, handler) {
        assert.ok(description);
        assert.equal(typeof shape, 'object');
        assert.equal(typeof handler, 'function');
        registered.push(n);
      },
    };
    const makeSchema = () => {
      const schema = { describe: () => schema, optional: () => schema, __zod: true };
      return schema;
    };
    const z = { string: makeSchema, number: makeSchema, boolean: makeSchema, array: makeSchema, enum: makeSchema };
    const result = registerMemoryTools(server, { z, service });
    assert.equal(result.failed.length, 0);
    assert.equal(result.registered.length, memoryToolSpecs.length);
    assert.ok(registered.every((name) => name.startsWith('memory_')));

    // 缺少 zod 时明确报错（而不是静默不注册）
    assert.throws(() => registerMemoryTools(server, {}), /zod/);
  } finally {
    cleanup();
  }
});
