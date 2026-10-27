/**
 * MCP 工具层（计划书 §12）。
 *
 * 为什么不自己开一个 MCP server：
 *   QQ 会话的执行期工具白名单（qq-bridge 的 qq-tool-restrict）只放行
 *   `mcp__snowluma__ / mcp__snowluma-host__ / mcp__web-search-safe__ / mcp__phone__`
 *   四个命名空间。新开一个 serverName 会得到 `mcp__xxx__` 前缀而被拒绝执行。
 *   因此本模块以**纯函数注册器**的形式挂到既有的 `snowluma-host` MCP server 上，
 *   在不改动任何 QQ agent 机制的前提下拿到可用工具名。
 *
 * 工具返回一律精简（摘要 + id），避免把整库记忆倒进上下文。
 */

import { getMemoryService } from './service.js';

function clip(text, max = 160) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code, message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2) }],
    isError: true,
  };
}

/**
 * 工具规格。`inputSchema` 用 JSON-Schema 子集描述，再由 registerMemoryTools 转成 zod。
 * 这样 spec 本身可以在测试里直接断言（不依赖 zod）。
 */
export const memoryToolSpecs = [
  {
    name: 'memory_remember',
    description:
      '把一条信息长期记住（写入锚点记忆库）。用于主人明确要求"记住…"，或你自己确认值得长期保留的事实/偏好/计划。'
      + '传 text 表示新内容；传 node_id 表示把已有记忆提升为 core 并重新激活。会返回 node_id，后续纠正/忘掉都用它。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容（一句话，越具体越好）' },
        node_id: { type: 'string', description: '已有记忆的 node_id（与 text 二选一）' },
        scope: { type: 'string', description: '记忆隔离范围，缺省用配置的默认值；不确定就别传' },
      },
    },
  },
  {
    name: 'memory_recall',
    description:
      '检索长期记忆。返回与当前话题相关的少量记忆（含 node_id / 类型 / 状态 / 来源 / 置信度）。'
      + '用 include_historical=true 查历史版本（例如"之前说过什么""是不是改过"）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前问题或话题关键词' },
        scope: { type: 'string' },
        include_historical: { type: 'boolean', description: '是否包含已被纠正/取消/过期的历史记忆' },
        max_tokens: { type: 'number', description: '本次注入的记忆预算（token）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_forget',
    description:
      '忘掉一条记忆（不可恢复）。传 node_id 精确删除；传 query 会先检索，目标唯一才删，'
      + '不唯一时只返回候选让人选择。删除会清空正文、锚点关系、关系边与全文索引。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        query: { type: 'string', description: '要忘掉的内容描述（与 node_id 二选一）' },
        scope: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_correct',
    description: '纠正一条记忆：以新内容替代旧值，旧记忆标记为已被替代，普通检索不再返回旧值。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: '被纠正的旧记忆 id' },
        text: { type: 'string', description: '纠正后的正确内容' },
        scope: { type: 'string' },
      },
      required: ['node_id', 'text'],
    },
  },
  {
    name: 'memory_list',
    description: '分页查看记忆（默认不含已删除内容）。可按类型/层级/状态/关键词/时间过滤，返回 node_id 便于后续纠正或删除。',
    inputSchema: {
      type: 'object',
      properties: {
        memory_type: { type: 'string', enum: ['preference', 'fact', 'plan', 'commitment', 'task', 'correction', 'event'] },
        tier: { type: 'string', enum: ['core', 'normal', 'edge'] },
        state: { type: 'string', enum: ['active', 'pending_confirm', 'superseded', 'cancelled', 'expired'] },
        keyword: { type: 'string' },
        created_after: { type: 'string', description: 'ISO 时间下界' },
        created_before: { type: 'string', description: 'ISO 时间上界' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        scope: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_confirm',
    description: '确认或否定一条待确认（pending_confirm）的记忆。confirmed=false 会让它退出普通检索。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        confirmed: { type: 'boolean' },
        scope: { type: 'string' },
      },
      required: ['node_id', 'confirmed'],
    },
  },
  {
    name: 'memory_write',
    description:
      '写入一条你自己观察到的记忆（不是主人明确说的）。这类记忆来源标为 agent_generated、默认进入待确认队列，'
      + '不会被当成已确认事实。主人明确要求记住请用 memory_remember。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记录的内容' },
        scope: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_health',
    description: '记忆库健康检查：schema 版本、FTS 可用性、条数、未完成删除、维护任务状态与周度指标。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        include_metrics: { type: 'boolean' },
      },
    },
  },
];

/**
 * 执行一个工具。与 MCP 传输层解耦，便于直接单测。
 * @param {string} toolName
 * @param {object} args
 * @param {object} [service] - 不给则用当前进程单例
 */
export function invokeMemoryTool(toolName, args = {}, service = null) {
  const svc = service ?? getMemoryService();
  const a = args && typeof args === 'object' ? args : {};
  const scope = a.scope ? String(a.scope) : undefined;

  switch (toolName) {
    case 'memory_remember': {
      if (!a.text && !a.node_id) return fail('missing_argument', '需要 text 或 node_id');
      const result = svc.remember({ text: a.text ? String(a.text) : undefined, nodeId: a.node_id ? String(a.node_id) : undefined }, { scope });
      if (!result.ok) {
        return fail(result.error ?? 'remember_failed', '写入失败', {
          hint: result.error === 'not_parsable' ? '内容无法结构化，请让主人说得更具体（谁/什么/什么时候）' : undefined,
          rejected: result.rejected,
        });
      }
      return ok({
        ok: true,
        node_id: result.nodeId,
        state: result.state,
        tier: 'core',
        promoted: result.promoted ?? false,
        scope: result.owner_scope,
      });
    }
    case 'memory_recall': {
      if (!a.query) return fail('missing_argument', '需要 query');
      const result = svc.recall(String(a.query), {
        scope,
        includeHistorical: a.include_historical === true,
        budgetTokens: Number.isFinite(a.max_tokens) ? Number(a.max_tokens) : undefined,
      });
      if (!result.ok) return fail(result.error ?? 'recall_failed', '检索失败', { message: result.message });
      return ok({
        ok: true,
        focus: result.focus,
        memories: result.memories.map((memory) => ({
          node_id: memory.node_id,
          memory_type: memory.memory_type,
          state: memory.state,
          source_type: memory.source_type,
          confidence: memory.confidence,
          valid_until: memory.valid_until,
          payload: memory.payload,
          summary: clip(memory.summary, 120),
        })),
        notes: {
          count: result.memories.length,
          candidate_count: result.retrieval_notes.candidate_count,
          truncated: result.retrieval_notes.truncated,
          used_tokens: result.retrieval_notes.used_tokens,
          disclaimer: result.retrieval_notes.disclaimer,
        },
      });
    }
    case 'memory_forget': {
      if (!a.node_id && !a.query) return fail('missing_argument', '需要 node_id 或 query');
      const result = svc.forget({ nodeId: a.node_id ? String(a.node_id) : undefined, query: a.query ? String(a.query) : undefined }, { scope });
      if (result.ok) {
        return ok({
          ok: true,
          node_id: result.nodeId,
          state: 'deleted',
          cleaned: result.stages,
          external_copies: result.externalCopies,
        });
      }
      if (result.error === 'ambiguous') {
        return ok({ ok: false, error: 'ambiguous', candidates: result.candidates, hint: result.hint, scope: result.owner_scope });
      }
      return fail(result.error ?? 'forget_failed', '删除未完成', {
        node_id: result.nodeId,
        blocking: result.blocking,
        purge_pending: result.purgePending,
        cleaned: result.stages,
        hint: result.hint,
      });
    }
    case 'memory_correct': {
      if (!a.node_id || !a.text) return fail('missing_argument', '需要 node_id 与 text');
      const result = svc.correct({ nodeId: String(a.node_id), text: String(a.text) }, { scope });
      if (!result.ok) return fail(result.error ?? 'correct_failed', '纠正失败');
      return ok({ ok: true, new_node_id: result.newNodeId, superseded_node_id: result.supersededNodeId, relation: result.relation });
    }
    case 'memory_list': {
      const result = svc.list(
        {
          memoryType: a.memory_type,
          tier: a.tier,
          state: a.state,
          keyword: a.keyword,
          createdAfter: a.created_after,
          createdBefore: a.created_before,
          limit: a.limit,
          offset: a.offset,
        },
        { scope },
      );
      return ok({
        ok: true,
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        memories: result.memories.map((memory) => ({
          node_id: memory.node_id,
          memory_type: memory.memory_type,
          tier: memory.tier,
          state: memory.state,
          summary: clip(memory.summary, 120),
          created_at: memory.created_at,
          valid_until: memory.valid_until,
        })),
      });
    }
    case 'memory_confirm': {
      if (!a.node_id) return fail('missing_argument', '需要 node_id');
      if (typeof a.confirmed !== 'boolean') return fail('missing_argument', 'confirmed 必须是布尔值');
      const result = svc.confirm({ nodeId: String(a.node_id), confirmed: a.confirmed }, { scope });
      if (!result.ok) return fail(result.error ?? 'confirm_failed', '确认失败', { hint: result.hint, state: result.state });
      return ok({ ok: true, node_id: result.nodeId, state: result.state });
    }
    case 'memory_write': {
      if (!a.text) return fail('missing_argument', '需要 text');
      const result = svc.write(String(a.text), { scope, sourceType: 'agent_generated' });
      if (!result.ok && result.error) return fail(result.error, '写入失败', { message: result.message });
      return ok({
        ok: true,
        written: result.written,
        rejected: result.rejected,
        note: '来源标记为 agent_generated，未达确认阈值的内容会进入 pending_confirm，不会自动当成已确认事实',
      });
    }
    case 'memory_health': {
      const health = svc.health();
      const payload = {
        ok: health.ok,
        enabled: health.enabled,
        schema_version: health.schemaVersion,
        fts5: health.fts5,
        counts: health.counts,
        warnings: health.warnings,
        errors: health.errors,
        adapter: { auto_inject: health.adapterAutoInject, presets: health.presets, budget: health.budget },
      };
      if (a.include_metrics === true) payload.weekly = svc.weekly({ scope });
      return ok(payload);
    }
    default:
      return fail('unknown_tool', `未知工具：${toolName}`);
  }
}

/** 把 JSON-Schema 子集翻译成 zod raw shape（由宿主传入 z，避免本包依赖 zod）。 */
export function buildZodShape(spec, z) {
  const shape = {};
  const required = new Set(spec.inputSchema.required ?? []);
  for (const [key, field] of Object.entries(spec.inputSchema.properties ?? {})) {
    let schema;
    if (field.enum) schema = z.enum(field.enum);
    else if (field.type === 'number' || field.type === 'integer') schema = z.number();
    else if (field.type === 'boolean') schema = z.boolean();
    else if (field.type === 'array') schema = z.array(z.string());
    else schema = z.string();
    if (field.description) schema = schema.describe(field.description);
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  return shape;
}

/**
 * 注册到宿主的 MCP server（`@modelcontextprotocol/sdk` 的 McpServer 实例）。
 *
 * @param {object} server - McpServer，需具备 `.tool(name, description, shape, handler)`
 * @param {{ z: object, service?: object, prefix?: string }} options
 * @returns {{ registered: string[], failed: Array<{name:string,message:string}> }}
 */
export function registerMemoryTools(server, options = {}) {
  const { z, service = null, prefix = '' } = options;
  if (!z) throw new Error('registerMemoryTools 需要宿主传入 zod（options.z）');
  const registered = [];
  const failed = [];
  let svc = service;
  const ensureService = () => {
    if (!svc) svc = getMemoryService();
    return svc;
  };
  // 先做一次健康探针：库坏了就不注册工具（避免模型反复调用一个坏工具），
  // 但仍不抛错，宿主 MCP server 要能继续提供它自己的工具。
  try {
    ensureService();
  } catch (error) {
    return { registered: [], failed: [{ name: '*', message: String(error?.message ?? error) }] };
  }

  for (const spec of memoryToolSpecs) {
    const toolName = `${prefix}${spec.name}`;
    try {
      server.tool(toolName, spec.description, buildZodShape(spec, z), async (args) => invokeMemoryTool(spec.name, args, svc));
      registered.push(toolName);
    } catch (error) {
      failed.push({ name: toolName, message: String(error?.message ?? error) });
    }
  }
  return { registered, failed };
}
