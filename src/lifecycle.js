/**
 * 生命周期维护（计划书 §9 / §11）。
 *
 * 三条不可违反的规则：
 *  1. 阶段（stage）不是删除：只改变注入表示的精细程度，不销毁唯一的原始结构。
 *  2. 200 天内不因年龄物理删除；本版本**根本没有**"按年龄物理删除"的代码路径。
 *  3. 每轮批处理最多把 stage 下移一级，且 core 有独立的宽限时间。
 */

import * as repo from './repository.js';
import { transaction } from './db.js';
import { newRunId } from './models.js';

const DAY_MS = 86400000;
const STAGE_DOWN = { full: 'summary', summary: 'keyword', keyword: 'anchor', anchor: null };

/**
 * 阶段降级：只处理"长时间没被真正使用"的活跃记忆。
 * @returns {{ demoted: number, details: object[] }}
 */
export function demoteStages(handle, cfg, ownerScope, { now = new Date(), batchSize = 200 } = {}) {
  const iso = now.toISOString();
  const rows = handle.db
    .prepare(
      `SELECT node_id, tier, stage, last_recalled_at, last_confirmed_at, created_at
       FROM memory_nodes
       WHERE owner_scope = ? AND state = 'active' AND stage <> 'anchor'
       ORDER BY COALESCE(last_recalled_at, created_at) ASC
       LIMIT ?`,
    )
    .all(ownerScope, batchSize);

  const details = [];
  for (const row of rows) {
    const next = STAGE_DOWN[row.stage];
    if (!next) continue;
    const last = new Date(row.last_recalled_at ?? row.created_at).getTime();
    const idleDays = (now.getTime() - last) / DAY_MS;
    const threshold = cfg.lifecycle.demoteIdleDays[row.stage] ?? Infinity;
    // core 层单独给宽限时间，避免重要偏好过早变成只剩锚点。
    const effectiveThreshold = row.tier === 'core' ? Math.max(threshold, cfg.lifecycle.coreGraceDays) : threshold;
    if (idleDays < effectiveThreshold) continue;
    details.push({ node_id: row.node_id, from: row.stage, to: next, idle_days: Number(idleDays.toFixed(1)) });
  }

  if (details.length === 0) return { demoted: 0, details: [] };
  transaction(handle, () => {
    const stmt = handle.db.prepare('UPDATE memory_nodes SET stage = ?, updated_at = ? WHERE node_id = ? AND owner_scope = ?');
    for (const detail of details) stmt.run(detail.to, iso, detail.node_id, ownerScope);
  });
  return { demoted: details.length, details };
}

/**
 * 召回成功后的表示回升：按策略升一级（不跨级跳跃，也不超过 full）。
 */
export function promoteStage(handle, ownerScope, nodeId, { now = new Date() } = {}) {
  const node = repo.getNode(handle, ownerScope, nodeId);
  if (!node || node.state === 'deleted') return null;
  const up = { anchor: 'keyword', keyword: 'summary', summary: 'full', full: null }[node.stage];
  if (!up) return null;
  repo.updateNode(handle, ownerScope, nodeId, { stage: up, updated_at: now.toISOString() });
  return up;
}

/** 处理已过 valid_until 的时间限定记忆：标 expired，但**不删除**内容。 */
export function expireDue(handle, cfg, ownerScope, { now = new Date(), batchSize = 500 } = {}) {
  const iso = now.toISOString();
  const rows = handle.db
    .prepare(
      `SELECT node_id, valid_until FROM memory_nodes
       WHERE owner_scope = ? AND state IN ('active','pending_confirm')
         AND valid_until IS NOT NULL AND valid_until < ?
       LIMIT ?`,
    )
    .all(ownerScope, iso, batchSize);
  if (rows.length === 0) return { expired: 0, ids: [] };
  transaction(handle, () => {
    const stmt = handle.db.prepare('UPDATE memory_nodes SET state = ?, updated_at = ? WHERE node_id = ? AND owner_scope = ?');
    for (const row of rows) stmt.run('expired', iso, row.node_id, ownerScope);
    for (const row of rows) {
      repo.recordEvent(handle, { ownerScope, op: 'expire', targetId: row.node_id, result: 'expired', now: iso });
    }
  });
  return { expired: rows.length, ids: rows.map((row) => row.node_id) };
}

/**
 * 重试未完成的删除清理。返回仍然失败的条目（失败必须可见）。
 */
export function retryPendingPurges(handle, cfg, ownerScope, { now = new Date(), limit = 50 } = {}) {
  const iso = now.toISOString();
  const rows = handle.db
    .prepare("SELECT node_id FROM memory_nodes WHERE owner_scope = ? AND purge_pending = 1 LIMIT ?")
    .all(ownerScope, Math.min(limit, cfg.lifecycle.purgeRetryLimit));
  const stillFailing = [];
  const completed = [];
  for (const row of rows) {
    try {
      transaction(handle, () => {
        repo.updateNode(handle, ownerScope, row.node_id, {
          payload_json: null,
          canonical_text: null,
          summary: null,
          source_ref: null,
          dedupe_key: null,
          topic_key: null,
          updated_at: iso,
        });
        handle.db.prepare('DELETE FROM node_anchors WHERE node_id = ? AND owner_scope = ?').run(row.node_id, ownerScope);
        handle.db
          .prepare('DELETE FROM memory_edges WHERE owner_scope = ? AND (from_node_id = ? OR to_node_id = ?)')
          .run(ownerScope, row.node_id, row.node_id);
        repo.ftsDelete(handle, row.node_id);
        repo.updateNode(handle, ownerScope, row.node_id, { purge_pending: 0, deleted_at: iso, updated_at: iso });
        repo.recordEvent(handle, { ownerScope, op: 'purge_retry', targetId: row.node_id, result: 'deleted', now: iso });
      });
      completed.push(row.node_id);
    } catch (error) {
      stillFailing.push({ node_id: row.node_id, message: String(error?.message ?? error).slice(0, 160) });
      try {
        repo.recordEvent(handle, {
          ownerScope,
          op: 'purge_retry',
          targetId: row.node_id,
          result: 'failed',
          errorCode: 'purge_failed',
          now: iso,
        });
      } catch {
        /* 审计失败不掩盖主失败 */
      }
    }
  }
  return { completed, stillFailing };
}

/** 一致性核验：孤儿关系、孤儿边、FTS 与节点不一致。只报告，不自动破坏性修复。 */
export function checkIntegrity(handle, ownerScope) {
  const orphanNodeAnchors = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM node_anchors na
       WHERE na.owner_scope = ?
         AND (NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.node_id = na.node_id)
           OR NOT EXISTS (SELECT 1 FROM anchors a WHERE a.anchor_id = na.anchor_id))`,
    )
    .get(ownerScope).c;
  const orphanEdges = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM memory_edges e
       WHERE e.owner_scope = ?
         AND (NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.node_id = e.from_node_id)
           OR NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.node_id = e.to_node_id))`,
    )
    .get(ownerScope).c;
  const ftsOrphans = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM memory_fts f
       WHERE NOT EXISTS (SELECT 1 FROM memory_nodes n WHERE n.node_id = f.node_id)`,
    )
    .get().c;
  const liveNodes = handle.db
    .prepare("SELECT COUNT(*) AS c FROM memory_nodes WHERE owner_scope = ? AND state <> 'deleted'")
    .get(ownerScope).c;
  const ftsRows = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM memory_fts f
       JOIN memory_nodes n ON n.node_id = f.node_id
       WHERE n.owner_scope = ? AND n.state <> 'deleted'`,
    )
    .get(ownerScope).c;
  return {
    orphan_node_anchors: orphanNodeAnchors,
    orphan_edges: orphanEdges,
    fts_orphans: ftsOrphans,
    live_nodes: liveNodes,
    live_fts_rows: ftsRows,
    fts_missing: Math.max(0, liveNodes - ftsRows),
  };
}

/**
 * 重建全文索引（可从节点正文重建，符合"缓存必须可从权威数据重建"）。
 */
export function rebuildIndex(handle, ownerScope, { now = new Date() } = {}) {
  const rows = handle.db
    .prepare("SELECT node_id, canonical_text, summary FROM memory_nodes WHERE owner_scope = ? AND state <> 'deleted'")
    .all(ownerScope);
  let rebuilt = 0;
  transaction(handle, () => {
    handle.db
      .prepare('DELETE FROM memory_fts WHERE node_id IN (SELECT node_id FROM memory_nodes WHERE owner_scope = ?)')
      .run(ownerScope);
    for (const row of rows) {
      repo.ftsUpsert(handle, row.node_id, `${row.canonical_text ?? ''} ${row.summary ?? ''}`);
      rebuilt += 1;
    }
    repo.recordEvent(handle, { ownerScope, op: 'rebuild_index', targetId: null, result: 'ok', detail: { rebuilt }, now: now.toISOString() });
  });
  return { rebuilt };
}

/** 去重候选：只发现、只报告，**不自动合并**（计划书 §7.4 / §11.1）。 */
export function dedupeCandidates(handle, ownerScope, { limit = 20 } = {}) {
  const rows = handle.db
    .prepare(
      `SELECT dedupe_key, COUNT(*) AS c, group_concat(node_id, ',') AS ids
       FROM memory_nodes
       WHERE owner_scope = ? AND state = 'active' AND dedupe_key IS NOT NULL
       GROUP BY dedupe_key HAVING c > 1
       ORDER BY c DESC LIMIT ?`,
    )
    .all(ownerScope, limit);
  return rows.map((row) => ({ dedupe_key: row.dedupe_key, count: Number(row.c), node_ids: String(row.ids).split(',') }));
}

/**
 * 超过保留期的**候选清单**。仅列出，不删除 —— 删除必须由用户显式发起。
 */
export function cleanupCandidates(handle, cfg, ownerScope, { now = new Date(), limit = 50 } = {}) {
  const cutoff = new Date(now.getTime() - cfg.retention.minimumNonDeletedRecallDays * DAY_MS).toISOString();
  return handle.db
    .prepare(
      `SELECT node_id, memory_type, tier, created_at, last_recalled_at
       FROM memory_nodes
       WHERE owner_scope = ? AND state = 'active' AND created_at < ? AND tier <> 'core'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(ownerScope, cutoff, limit)
    .map((row) => ({
      node_id: row.node_id,
      memory_type: row.memory_type,
      tier: row.tier,
      created_at: row.created_at,
      note: '仅列为清理候选；本插件不会因年龄自动删除，删除需显式 forget',
    }));
}

/**
 * 每日维护。带运行锁与运行记录；单步失败不影响其余步骤，但失败必须被记录。
 */
export function runDaily(handle, cfg, ownerScope, { now = new Date(), holder = newRunId() } = {}) {
  const iso = now.toISOString();
  const lockName = `daily:${ownerScope}`;
  if (!repo.acquireLock(handle, lockName, holder, { now: iso, ttlMs: 10 * 60 * 1000 })) {
    return { ok: false, skipped: true, reason: 'locked' };
  }
  const runId = repo.startRun(handle, 'daily', iso);
  let processed = 0;
  let failed = 0;
  const steps = {};
  try {
    steps.demote = demoteStages(handle, cfg, ownerScope, { now });
    processed += steps.demote.demoted;
    steps.expire = expireDue(handle, cfg, ownerScope, { now });
    processed += steps.expire.expired;
    steps.purge = retryPendingPurges(handle, cfg, ownerScope, { now });
    processed += steps.purge.completed.length;
    failed += steps.purge.stillFailing.length;
    steps.integrity = checkIntegrity(handle, ownerScope);
    steps.dedupe = dedupeCandidates(handle, ownerScope);
    steps.cleanupCandidates = cleanupCandidates(handle, cfg, ownerScope, { now }).length;
    repo.finishRun(handle, runId, {
      processed,
      failed,
      detail: {
        demoted: steps.demote.demoted,
        expired: steps.expire.expired,
        purge_completed: steps.purge.completed.length,
        purge_failed: steps.purge.stillFailing.length,
        dedupe_groups: steps.dedupe.length,
        cleanup_candidates: steps.cleanupCandidates,
      },
      now: new Date().toISOString(),
    });
    return { ok: true, runId, processed, failed, steps };
  } catch (error) {
    repo.finishRun(handle, runId, {
      processed,
      failed: failed + 1,
      errorCode: 'daily_failed',
      detail: { message: String(error?.message ?? error).slice(0, 200) },
      now: new Date().toISOString(),
    });
    return { ok: false, runId, error: String(error?.message ?? error), steps };
  } finally {
    repo.releaseLock(handle, lockName, holder);
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

/**
 * 周度指标（计划书 §11.2）。全部基于本地记录统计，不包含任何记忆正文。
 */
export function weeklyMetrics(handle, ownerScope, { now = new Date(), days = 7 } = {}) {
  const from = new Date(now.getTime() - days * DAY_MS).toISOString();
  const to = now.toISOString();
  const recallLatency = repo.statsBetween(handle, 'recall_latency_ms', from, to);
  const candidates = repo.statsBetween(handle, 'candidate_count', from, to);
  const selected = repo.statsBetween(handle, 'selected_count', from, to);
  const usedTokens = repo.statsBetween(handle, 'used_tokens', from, to);
  const recalls = repo.statsBetween(handle, 'recall_total', from, to);
  const emptyRecalls = repo.statsBetween(handle, 'recall_empty', from, to);
  const deleteFailures = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM memory_events
       WHERE owner_scope = ? AND op IN ('forget_memory','purge_retry') AND result = 'failed' AND created_at >= ?`,
    )
    .get(ownerScope, from).c;
  const pendingPurges = handle.db
    .prepare('SELECT COUNT(*) AS c FROM memory_nodes WHERE owner_scope = ? AND purge_pending = 1')
    .get(ownerScope).c;
  const sum = (values) => values.reduce((acc, value) => acc + value, 0);
  return {
    window_days: days,
    from,
    to,
    recall_calls: recalls.length,
    empty_recall_rate: recalls.length === 0 ? null : Number((emptyRecalls.length / recalls.length).toFixed(4)),
    avg_candidate_count: candidates.length === 0 ? null : Number((sum(candidates) / candidates.length).toFixed(2)),
    avg_selected_count: selected.length === 0 ? null : Number((sum(selected) / selected.length).toFixed(2)),
    avg_injected_tokens: usedTokens.length === 0 ? null : Number((sum(usedTokens) / usedTokens.length).toFixed(1)),
    p95_latency_ms: percentile(recallLatency, 95),
    p50_latency_ms: percentile(recallLatency, 50),
    delete_failures: deleteFailures,
    purge_pending: pendingPurges,
    integrity: checkIntegrity(handle, ownerScope),
    note: '指标来自插件本地记录；未包含模型调用或远程嵌入耗时',
  };
}
