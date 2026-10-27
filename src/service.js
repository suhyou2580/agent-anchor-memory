/**
 * 服务门面：把 config / db / repository / writer / retriever / control / lifecycle
 * 组装成一个可被 MCP 工具和 Harness 插件共同调用的对象。
 *
 * 这一层负责三件横切的事：
 *  1. scope 解析与校验（所有入口都必须落在单一 owner_scope）。
 *  2. 事务与错误隔离（记忆库坏了不能拖垮主对话；但删除失败必须如实上报）。
 *  3. 指标记录（只记数值，不记正文）。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig, resolveDatabasePath, resolveMemoryBudget } from './config.js';
import { openDatabase, migrate, health as dbHealth, transaction, probeFts5 } from './db.js';
import * as repo from './repository.js';
import * as writer from './writer.js';
import * as retriever from './retriever.js';
import * as control from './control.js';
import * as lifecycle from './lifecycle.js';
import { effectiveStrength } from './scoring.js';
import { fingerprint, RECALLABLE_STATES } from './models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');

control.initControl(writer);

const SCOPE_PATTERN = /^[A-Za-z0-9_:.\-]{1,128}$/;

/**
 * 创建（或复用）一个记忆服务实例。
 * @param {{ configFile?: string, config?: object, baseDir?: string, env?: object, migrateToLatest?: boolean }} [options]
 */
export function createMemoryService(options = {}) {
  const baseDir = options.baseDir ?? PLUGIN_ROOT;
  const cfg = options.config
    ? validateConfig(options.config)
    : loadConfig({ filePath: options.configFile, env: options.env });
  const databasePath = resolveDatabasePath(cfg, baseDir);

  const handle = openDatabase(databasePath);
  if (options.migrateToLatest !== false) migrate(handle);
  const ftsAvailable = probeFts5(handle);

  // 安装级 HMAC 密钥：优先配置/环境变量，否则首次生成并存进本库。
  let installKey = cfg.hmacKey && cfg.hmacKey.length > 0 ? cfg.hmacKey : null;
  if (!installKey) {
    installKey = repo.getMeta(handle, 'install_hmac_key');
    if (!installKey) {
      installKey = crypto.randomBytes(32).toString('hex');
      repo.setMeta(handle, 'install_hmac_key', installKey);
    }
  }
  const hash = (value) => fingerprint(installKey, value);

  function resolveScope(scope) {
    const value = scope === undefined || scope === null || scope === '' ? cfg.defaultScope : String(scope);
    if (!SCOPE_PATTERN.test(value)) throw new Error(`owner_scope 非法：${JSON.stringify(value)}（只允许字母数字与 _ : . -，长度 1~128）`);
    return value;
  }

  function recordRecallMetrics(scope, result, nowIso) {
    try {
      repo.insertStat(handle, scope, 'recall_total', 1, nowIso);
      repo.insertStat(handle, scope, 'recall_latency_ms', result.metrics.latencyMs, nowIso);
      repo.insertStat(handle, scope, 'candidate_count', result.metrics.candidateCount, nowIso);
      repo.insertStat(handle, scope, 'selected_count', result.metrics.selectedCount, nowIso);
      repo.insertStat(handle, scope, 'used_tokens', result.metrics.usedTokens, nowIso);
      if (result.metrics.empty) repo.insertStat(handle, scope, 'recall_empty', 1, nowIso);
    } catch {
      // 指标失败绝不影响召回结果。
    }
  }

  const service = {
    cfg,
    handle,
    databasePath,
    ftsAvailable,

    /** 关闭数据库连接。 */
    close() {
      if (!handle.closed) {
        try {
          handle.db.close();
        } catch {
          /* close 失败不掩盖上层结果 */
        }
        handle.closed = true;
      }
    },

    health() {
      const base = dbHealth(handle);
      return {
        ...base,
        ftsAvailable,
        enabled: cfg.enabled,
        defaultScope: cfg.defaultScope,
        adapterAutoInject: cfg.adapter.autoInject,
        presets: cfg.adapter.presets,
        budget: resolveMemoryBudget(cfg),
        lastRuns: repo.lastRuns(handle, 5),
      };
    },

    /** 写入：从原始文本抽取并落库。 */
    write(text, opts = {}) {
      const scope = resolveScope(opts.scope);
      const now = opts.now ?? new Date();
      if (!cfg.enabled) return { ok: false, error: 'disabled' };
      let out;
      try {
        out = transaction(handle, () => writer.writeText(handle, cfg, scope, text, {
          now,
          sourceType: opts.sourceType ?? 'user_explicit',
          sourceRef: opts.sourceRef ?? null,
          hash,
          allowSuppressed: opts.allowSuppressed === true,
        }));
      } catch (error) {
        return { ok: false, error: 'write_failed', message: String(error?.message ?? error) };
      }
      return {
        ok: out.written.some((item) => item.nodeId),
        owner_scope: scope,
        written: out.written.map((item) => ({
          node_id: item.nodeId,
          memory_type: item.memoryType,
          state: item.state,
          confidence: item.confidence,
          pending_confirm: item.pendingConfirm,
          deduplicated: Boolean(item.duplicateOf),
          superseded: item.superseded,
          anchors: item.anchors.map((anchor) => anchor.display_token),
        })),
        rejected: out.rejected,
        suppressed: out.suppressed,
      };
    },

    /** 召回；同时记录指标并更新 last_recalled_at（只对真正注入的节点）。 */
    recall(query, opts = {}) {
      const scope = resolveScope(opts.scope);
      const now = opts.now ?? new Date();
      const nowIso = now.toISOString();
      if (!cfg.enabled) return { ok: false, error: 'disabled' };
      let result;
      try {
        result = retriever.recall(handle, cfg, scope, query, {
          now,
          budgetTokens: opts.budgetTokens,
          includeHistorical: opts.includeHistorical === true,
          includeSensitive: opts.includeSensitive === true,
        });
      } catch (error) {
        return { ok: false, error: 'recall_failed', message: String(error?.message ?? error) };
      }
      recordRecallMetrics(scope, result, nowIso);
      if (result.selectedIds.length > 0) {
        try {
          transaction(handle, () => {
            for (const nodeId of result.selectedIds) {
              const node = repo.getNode(handle, scope, nodeId);
              if (!node || node.state !== 'active') continue;
              const current = effectiveStrength(node, now, cfg.strength);
              const boosted = Math.min(1, current + cfg.strength.recallBoost);
              repo.updateNode(handle, scope, nodeId, {
                last_recalled_at: nowIso,
                strength_base: Number(boosted.toFixed(4)),
                strength_base_at: nowIso,
                updated_at: nowIso,
              });
              if (node.stage !== 'full') lifecycle.promoteStage(handle, scope, nodeId, { now });
            }
            repo.recordEvent(handle, {
              ownerScope: scope,
              op: 'recall_memory',
              targetId: null,
              result: 'ok',
              detail: { candidates: result.metrics.candidateCount, selected: result.metrics.selectedCount },
              now: nowIso,
            });
          });
        } catch {
          // 用量统计失败不影响本次注入。
        }
      }
      return { ok: true, owner_scope: scope, ...result };
    },

    /** 召回并渲染成可注入的文本片段（供回复前注入使用）。 */
    recallForInjection(query, opts = {}) {
      const result = service.recall(query, opts);
      if (!result.ok) return { ok: false, error: result.error, text: '', result: null };
      return {
        ok: true,
        text: retriever.renderInjection(result, cfg),
        result,
        budgetTokens: result.metrics.budgetTokens,
      };
    },

    remember(input, opts = {}) {
      const scope = resolveScope(opts.scope);
      const out = control.rememberMemory(handle, cfg, scope, {
        nodeId: input?.nodeId,
        text: input?.text,
        now: opts.now ?? new Date(),
        hash,
      });
      return { ...out, owner_scope: scope };
    },

    forget(input, opts = {}) {
      const scope = resolveScope(opts.scope);
      const now = opts.now ?? new Date();
      if (input?.nodeId) return { owner_scope: scope, ...control.forgetMemory(handle, cfg, scope, { nodeId: input.nodeId, now, hash }) };
      return { owner_scope: scope, ...control.forgetByQuery(handle, cfg, scope, { query: input?.query, now, hash }) };
    },

    correct(input, opts = {}) {
      const scope = resolveScope(opts.scope);
      const out = control.correctMemory(handle, cfg, scope, {
        nodeId: input?.nodeId,
        text: input?.text,
        now: opts.now ?? new Date(),
      });
      return { ...out, owner_scope: scope };
    },

    list(filter = {}, opts = {}) {
      const scope = resolveScope(opts.scope);
      const page = control.listMemories(handle, cfg, scope, filter);
      return { owner_scope: scope, ...page };
    },

    detail(nodeId, opts = {}) {
      const scope = resolveScope(opts.scope);
      const node = control.getMemoryDetail(handle, scope, nodeId);
      return node ? { ok: true, owner_scope: scope, memory: node } : { ok: false, error: 'not_found', nodeId };
    },

    confirm(input, opts = {}) {
      const scope = resolveScope(opts.scope);
      const out = control.confirmMemory(handle, cfg, scope, {
        nodeId: input?.nodeId,
        confirmed: input?.confirmed,
        now: opts.now ?? new Date(),
      });
      return { ...out, owner_scope: scope };
    },

    daily(opts = {}) {
      const scope = resolveScope(opts.scope);
      return { owner_scope: scope, ...lifecycle.runDaily(handle, cfg, scope, { now: opts.now ?? new Date() }) };
    },

    weekly(opts = {}) {
      const scope = resolveScope(opts.scope);
      return { owner_scope: scope, ...lifecycle.weeklyMetrics(handle, scope, { now: opts.now ?? new Date(), days: opts.days }) };
    },

    integrity(opts = {}) {
      const scope = resolveScope(opts.scope);
      return { owner_scope: scope, ...lifecycle.checkIntegrity(handle, scope) };
    },

    rebuildIndex(opts = {}) {
      const scope = resolveScope(opts.scope);
      return { owner_scope: scope, ...lifecycle.rebuildIndex(handle, scope, { now: opts.now ?? new Date() }) };
    },

    cleanupCandidates(opts = {}) {
      const scope = resolveScope(opts.scope);
      return { owner_scope: scope, candidates: lifecycle.cleanupCandidates(handle, cfg, scope, { now: opts.now ?? new Date() }) };
    },

    /** 内部：可用注入预算（供适配器按真实上下文窗口收紧）。 */
    budget(contextWindowTokens) {
      return resolveMemoryBudget(cfg, contextWindowTokens);
    },

    resolveScope,
    hash,
  };

  return service;
}

// ── 进程内单例：MCP 工具与 Harness 插件各自 import 时共用同一个连接 ────────────
const instances = new Map();

/**
 * 取（或创建）以数据库路径为键的单例服务。
 * 同一个进程里既跑 MCP server 又跑插件时，避免开出两个连接抢 WAL 锁。
 */
export function getMemoryService(options = {}) {
  const key = options.configFile ?? options.config?.databasePath ?? `${PLUGIN_ROOT}::default`;
  const existing = instances.get(key);
  if (existing) return existing;
  const created = createMemoryService(options);
  instances.set(key, created);
  return created;
}

export function closeAllMemoryServices() {
  for (const service of instances.values()) service.close();
  instances.clear();
}

export { RECALLABLE_STATES };
