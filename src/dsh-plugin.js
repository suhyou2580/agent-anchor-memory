/**
 * DSH（Cordis）Host 插件：**回复前自动注入记忆**（计划书 §3 模式 A）。
 *
 * 为什么这是模式 A 而不是模式 B：
 *   DSH 提供 `agent/pre-step` 瀑布式钩子，它在"模型请求之前、步骤决议之时"触发，
 *   允许替换进入该步骤的消息列表（`PreStepDecision.messages`）。我们在这个位置
 *   追加一条**带来源标签**的 user 消息，因此检索确实发生在模型生成回复之前，
 *   不需要依赖模型主动调用任何工具。
 *
 * 注意（不要踩的坑）：
 *  - `agent/request` 不能改请求消息；只有 `agent/pre-step` 能。
 *  - 必须原样展开 decision（`{...decision, messages}`），否则会丢掉
 *    `startsRequestSeries` 之类字段。
 *  - 消息必须带非 `user` 的 `source.kind` 标签，否则在派生历史里会被当成真人发言。
 *  - 钩子里**任何异常都必须吞掉**并只记日志：记忆库坏了不能拖垮聊天。
 */

import crypto from 'node:crypto';
import { createMemoryService } from './service.js';
import { createLogger } from './log.js';

export const name = 'anchor-memory';

const pluginLog = createLogger({ file: process.env.ANCHOR_MEMORY_LOG_FILE || null });

/** 每个 agent 上一次注入的 turn，避免同一轮每一步都重复注入。 */
const injectedTurns = new WeakMap();

/**
 * 从 pre-step 的消息里取出"本轮真正的用户输入"。
 * 只认 `source.kind === 'user'` 的消息，避免把我们自己注入的参考数据当成查询。
 */
export function extractUserQuery(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    if (message.source && message.source.kind && message.source.kind !== 'user') continue;
    const parts = [];
    for (const block of message.content ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    const text = parts.join('\n').trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** 构造函数导出的对象便于单测（不依赖 Cordis 运行时）。 */
export function buildInjectionMessage(text, summary) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'anchor-memory',
      form: 'notice',
      summary: summary.length > 120 ? `${summary.slice(0, 119)}…` : summary,
    },
  };
}

/**
 * 判断某个 agent 是否属于本插件应注入的会话。
 * 三级判定，逐级降级，全部失败时按配置决定是否放弃。
 */
export function isTargetAgent(ctx, agent, presets) {
  if (!Array.isArray(presets) || presets.length === 0) return true; // 显式要求"全部会话"
  const candidates = [];
  try {
    const fromMeta = agent?.session?.meta?.agentPreset;
    if (typeof fromMeta === 'string' && fromMeta.length > 0) candidates.push(fromMeta);
  } catch {
    /* meta 不可读时继续 */
  }
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
    if (registry && typeof registry.composedPreset === 'function') {
      const fromRegistry = registry.composedPreset(agent.ctx);
      if (typeof fromRegistry === 'string' && fromRegistry.length > 0) candidates.push(fromRegistry);
    }
  } catch {
    /* 兼容不同 DSH 版本 */
  }
  return candidates.some((value) => presets.includes(value));
}

/**
 * 插件装配入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rowConfig] - cordis.patch.yml 该行可选配置（覆盖 config.json）
 */
export function apply(ctx, rowConfig) {
  let service = null;
  let disabledReason = null;
  try {
    service = createMemoryService({
      configFile: process.env.ANCHOR_MEMORY_CONFIG || undefined,
      config: rowConfig && Object.keys(rowConfig).length > 0 ? rowConfig : undefined,
      baseDir: process.env.ANCHOR_MEMORY_BASE_DIR || undefined,
    });
  } catch (error) {
    disabledReason = `初始化失败：${error?.message ?? error}`;
    pluginLog.error('anchor-memory 插件初始化失败，自动注入已停用（普通聊天不受影响）', { reason: disabledReason });
    return;
  }

  if (!service.cfg.enabled) {
    pluginLog.info('anchor-memory 已按配置停用');
    return;
  }
  if (!service.cfg.adapter.autoInject) {
    pluginLog.info('anchor-memory 自动注入已关闭（仅保留工具调用模式）');
    return;
  }

  const presets = service.cfg.adapter.presets;
  let injectedCount = 0;
  let skippedCount = 0;
  let closed = false;

  // 插件卸载/HMR 时关闭数据库连接。不这么做会在 Windows 上锁住库文件，
  // 导致升级、备份、删除都失败（实测：卸载后 rm 报 EPERM）。
  ctx.effect(() => () => {
    if (closed) return;
    closed = true;
    try {
      service.close();
    } catch {
      /* 关闭失败不影响卸载 */
    }
  });

  pluginLog.info('anchor-memory 自动注入已启用', {
    db: service.databasePath,
    scope: service.cfg.defaultScope,
    presets: presets.join(','),
    fts: service.ftsAvailable,
  });

  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter') return decision;
      const agent = payload?.agent;
      if (!agent) return decision;
      if (!isTargetAgent(ctx, agent, presets)) {
        skippedCount += 1;
        return decision;
      }
      const turn = payload.turn;
      if (injectedTurns.get(agent) === turn) return decision;

      const query = extractUserQuery(decision.messages);
      if (query.length < 2) return decision;

      const budget = service.budget(service.cfg.adapter.contextWindowTokens);
      const recalled = service.recallForInjection(query, { budgetTokens: budget.budgetTokens });
      if (!recalled.ok || !recalled.text) return decision;

      injectedTurns.set(agent, turn);
      injectedCount += 1;
      // 注入位置：紧贴在本轮用户输入之前，而不是整段历史之前。
      //
      // 为什么不能放最前面（v1 就是这么写的，实测代价很大）：
      // DeepSeek 是**前缀缓存**，只有请求开头和上一次逐 token 一致时才按 cacheHit 计价
      // （¥0.02/M），否则整段按 cacheMiss 重算（¥1/M）。把一条内容每轮都不同的记忆
      // 放在消息列表第 0 位，等于每轮都换掉前缀 → 整段历史全 miss，实测命中率从 98.8%
      // 掉到接近 0，输入侧成本涨约 7~8 倍。
      //
      // 放在末尾则只影响"记忆 + 最后一条新消息"这一小段——它本来就要重算，
      // 等于**加记忆几乎不花钱**，而前面的历史继续命中缓存。
      const injected = buildInjectionMessage(recalled.text, `记忆 ${recalled.result.memories.length} 条`);
      const merged = [...decision.messages];
      const insertAt = Math.max(0, merged.length - 1);
      merged.splice(insertAt, 0, injected);
      return { ...decision, messages: merged };
    } catch (error) {
      // 记忆不可用时降级为"无记忆"，绝不影响回复流程。
      pluginLog.error('自动注入失败，本次降级为无记忆', { message: String(error?.message ?? error).slice(0, 160) });
      return decision;
    }
  });

  // 让运维能观察到插件确实在工作（不输出任何记忆正文）。
  ctx.effect(() => {
    const timer = setInterval(() => {
      pluginLog.debug('anchor-memory 运行统计', { injected: injectedCount, presetSkip: skippedCount });
    }, 30 * 60 * 1000);
    return () => clearInterval(timer);
  });

  return dispose;
}

export default { name, apply };
