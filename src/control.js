/**
 * 显式控制：remember / forget / correct / list / confirm（计划书 §10）。
 *
 * 最重要的一条不变量（§10.2 / §6 交付原则）：
 *   删除要么**完整成功**，要么**明确失败并且目标继续被屏蔽**；
 *   任何一步清理失败都不许报告成功。
 */

import * as repo from './repository.js';
import { transaction } from './db.js';
import { newNodeId, fingerprint, RECALLABLE_STATES } from './models.js';
import { extractCandidates, extractAnchorTokens } from './extractor.js';
import { recall } from './retriever.js';
import { normalizeText } from './tokenize.js';

const nowIso = (now) => new Date(now).toISOString();

/**
 * 记住：把一段内容（或一个已有节点）提升为 core 并进入 active。
 * @param {object} handle
 * @param {object} cfg
 * @param {string} ownerScope
 * @param {{ text?: string, nodeId?: string, now?: Date, hash?: Function }} input
 */
export function rememberMemory(handle, cfg, ownerScope, input) {
  const now = input.now ?? new Date();
  const iso = nowIso(now);

  if (input.nodeId) {
    const node = repo.getNode(handle, ownerScope, input.nodeId);
    if (!node) return { ok: false, error: 'not_found', nodeId: input.nodeId };
    if (node.state === 'deleted') return { ok: false, error: 'node_deleted', nodeId: input.nodeId };
    transaction(handle, () => {
      repo.updateNode(handle, ownerScope, input.nodeId, {
        state: 'active',
        tier: 'core',
        last_confirmed_at: iso,
        strength_base: 1,
        strength_base_at: iso,
        updated_at: iso,
      });
      repo.recordEvent(handle, {
        ownerScope,
        op: 'remember_memory',
        targetId: input.nodeId,
        result: 'promoted',
        now: iso,
      });
    });
    return { ok: true, nodeId: input.nodeId, promoted: true, state: 'active', tier: 'core' };
  }

  const text = String(input.text ?? '').trim();
  if (text.length === 0) return { ok: false, error: 'empty_text' };

  const { candidates, rejected } = extractCandidates(text, { now, sourceType: 'user_explicit' });
  if (candidates.length === 0) {
    return { ok: false, error: 'not_parsable', rejected };
  }
  const candidate = { ...candidates[0], tier: 'core', requestedState: 'active', explicit: true };

  let created = null;
  transaction(handle, () => {
    created = writeForced(handle, cfg, ownerScope, candidate, iso);
  });
  if (!created || !created.nodeId) {
    return { ok: false, error: created?.reason ?? 'write_failed', rejected };
  }
  return { ok: true, nodeId: created.nodeId, promoted: false, state: created.state, tier: 'core' };
}

/** 强制写入（跳过置信度路由，但仍走隐私闸门与结构校验）。 */
function writeForced(handle, cfg, ownerScope, candidate, iso) {
  const { writeCandidate } = requireWriter();
  return writeCandidate(handle, cfg, ownerScope, { ...candidate, requestedState: 'active' }, { now: new Date(iso) });
}

// writer 与 control 互相引用会形成环；用一个惰性取用的桥，保持模块加载顺序无关。
let writerModule = null;
function requireWriter() {
  if (!writerModule) {
    throw new Error('writer 模块尚未注入：请通过 service 初始化（control.initControl(writer)）');
  }
  return writerModule;
}

/** 由 service 在启动时注入 writer，避免 ESM 循环依赖。 */
export function initControl(writer) {
  writerModule = writer;
}

// ── 忘掉 ────────────────────────────────────────────────────────────────────

/**
 * 按 nodeId 忘掉一条记忆（删除闭环）。
 *
 * 两阶段：
 *  阶段 1（必须成功）：state='deleted' + purge_pending=1 —— 立刻退出召回。
 *  阶段 2（尽力完成）：清正文、删锚点关系、删边、删 FTS、写抑制标记。
 * 阶段 2 失败 -> 返回 ok=false，purge_pending 保持 1，maintenance 会重试。
 */
export function forgetMemory(handle, cfg, ownerScope, { nodeId, now = new Date(), hash = null }) {
  const iso = nowIso(now);
  const node = repo.getNode(handle, ownerScope, nodeId);
  if (!node) {
    return { ok: false, error: 'not_found', nodeId, blocking: false };
  }

  // ── 阶段 1：屏蔽召回（整体成功或整体失败）──
  transaction(handle, () => {
    repo.updateNode(handle, ownerScope, nodeId, {
      state: 'deleted',
      purge_pending: 1,
      updated_at: iso,
    });
    repo.recordEvent(handle, {
      ownerScope,
      op: 'forget_memory',
      targetId: nodeId,
      result: 'blocked',
      now: iso,
    });
  });

  // ── 阶段 2：清理正文与索引 ──
  const stages = [];
  try {
    transaction(handle, () => {
      // 2a. 正文：payload / canonical / summary 全部置空
      repo.updateNode(handle, ownerScope, nodeId, {
        payload_json: null,
        canonical_text: null,
        summary: null,
        source_ref: null,
        dedupe_key: null,
        topic_key: null,
        purge_pending: 1,
        updated_at: iso,
      });
      stages.push('content');
      // 2b. 节点与锚点关系
      handle.db.prepare('DELETE FROM node_anchors WHERE node_id = ? AND owner_scope = ?').run(nodeId, ownerScope);
      stages.push('node_anchors');
      // 2c. 关系边
      handle.db
        .prepare('DELETE FROM memory_edges WHERE owner_scope = ? AND (from_node_id = ? OR to_node_id = ?)')
        .run(ownerScope, nodeId, nodeId);
      stages.push('edges');
      // 2d. 全文索引
      repo.ftsDelete(handle, nodeId);
      stages.push('fts');
      // 2e. 抑制标记（只存 HMAC 指纹，绝不存正文）
      if (typeof hash === 'function' && node.payload) {
        const marker = hash(`${node.memory_type}|${node.payload.subject ?? ''}|${node.payload.object ?? ''}`);
        repo.insertForgetMarker(handle, ownerScope, 'topic_fingerprint', marker, iso);
        stages.push('forget_marker');
      }
      // 2f. 收尾：清 purge_pending，写 deleted_at
      repo.updateNode(handle, ownerScope, nodeId, { purge_pending: 0, deleted_at: iso, updated_at: iso });
      repo.recordEvent(handle, {
        ownerScope,
        op: 'forget_memory',
        targetId: nodeId,
        result: 'deleted',
        detail: { stages },
        now: iso,
      });
    });
    return {
      ok: true,
      nodeId,
      state: 'deleted',
      stages,
      purgePending: false,
      // 诚实边界：QQ 平台侧原始聊天记录不受本插件控制。
      externalCopies: [
        'QQ 平台聊天记录（SnowLuma / 腾讯服务器）不在本插件控制范围内，本操作不会删除它们',
        '本插件在删除时已清空自身库内正文、锚点关系、关系边与全文索引条目',
      ],
    };
  } catch (error) {
    // 失败：保持 purge_pending=1（召回已被阶段 1 屏蔽），记录失败阶段供重试。
    try {
      transaction(handle, () => {
        repo.recordEvent(handle, {
          ownerScope,
          op: 'forget_memory',
          targetId: nodeId,
          result: 'failed',
          errorCode: 'purge_failed',
          detail: { stages, message: String(error?.message ?? error).slice(0, 200) },
          now: iso,
        });
      });
    } catch {
      /* 连审计都写不进去时也不能伪报成功 */
    }
    return {
      ok: false,
      nodeId,
      error: 'purge_failed',
      blocking: true,
      purgePending: true,
      stages,
      message: String(error?.message ?? error),
      hint: '召回已被屏蔽；请运行 memory_health 确认 purge_pending 并通过 maintenance 重试清理',
    };
  }
}

/**
 * 按内容/关键词忘掉。目标不唯一时**不批量删除**，而是把候选列出来让人选。
 */
export function forgetByQuery(handle, cfg, ownerScope, { query, now = new Date(), hash = null, maxCandidates = 5 }) {
  const text = String(query ?? '').trim();
  if (text.length === 0) return { ok: false, error: 'empty_query' };

  const result = recall(handle, cfg, ownerScope, text, {
    now,
    budgetTokens: cfg.recall.maxMemoryTokens,
    includeHistorical: false,
  });

  if (result.memories.length === 0) {
    return { ok: false, error: 'no_match', query: text, candidates: [] };
  }
  if (result.memories.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      query: text,
      candidates: result.memories.slice(0, maxCandidates).map((memory) => ({
        node_id: memory.node_id,
        memory_type: memory.memory_type,
        summary: memory.summary ?? JSON.stringify(memory.payload ?? {}),
        confidence: memory.confidence,
        state: memory.state,
      })),
      hint: '目标不唯一：请用 node_id 指定要忘掉的那一条，避免误删',
    };
  }
  return forgetMemory(handle, cfg, ownerScope, { nodeId: result.memories[0].node_id, now, hash });
}

// ── 纠正 ────────────────────────────────────────────────────────────────────

/**
 * 纠正一条记忆：新建节点 + 旧节点标 superseded + 版本边。
 * 普通召回之后不会再返回旧值（state 过滤），只有历史查询能看到。
 */
export function correctMemory(handle, cfg, ownerScope, { nodeId, text, now = new Date() }) {
  const iso = nowIso(now);
  const target = repo.getNode(handle, ownerScope, nodeId);
  if (!target) return { ok: false, error: 'not_found', nodeId };
  if (target.state === 'deleted') return { ok: false, error: 'node_deleted', nodeId };

  const newText = String(text ?? '').trim();
  if (newText.length === 0) return { ok: false, error: 'empty_text' };

  const { candidates, rejected } = extractCandidates(newText, { now, sourceType: 'user_explicit' });
  const base = candidates[0];
  const newId = newNodeId();
  const parsed = base?.payload ?? {};
  // 纠正本身是用户明确给出的新事实：抽不到明确状态时按"已确认"处理，
  // 但保留 considering/planned/cancelled 这类用户真的说了的状态。
  const correctionStatus = ['unknown', 'undecided'].includes(parsed.status) ? 'confirmed' : parsed.status ?? 'confirmed';
  const payload = {
    subject: parsed.subject ?? target.payload?.subject,
    action: target.payload?.action ?? parsed.action,
    object: parsed.object ?? target.payload?.object,
    when: parsed.when ?? target.payload?.when,
    status: correctionStatus,
    source_type: 'user_explicit',
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined || payload[key] === null) delete payload[key];

  transaction(handle, () => {
    repo.insertNode(handle, {
      node_id: newId,
      owner_scope: ownerScope,
      payload_json: JSON.stringify(payload),
      canonical_text: newText.slice(0, cfg.extract.maxCanonicalChars),
      summary: newText.length > cfg.extract.maxSummaryChars
        ? `${newText.slice(0, cfg.extract.maxSummaryChars - 1)}…`
        : newText,
      memory_type: target.memory_type,
      tier: target.tier,
      stage: 'full',
      state: 'active',
      extraction_confidence: 0.95,
      source_confidence: 1,
      source_type: 'user_explicit',
      source_ref: null,
      strength_base: 1,
      strength_base_at: iso,
      last_confirmed_at: iso,
      supersedes_node_id: nodeId,
      sensitivity: target.sensitivity,
      created_at: iso,
      updated_at: iso,
      dedupe_key: null,
      topic_key: null,
    });

    const push = (token, type, role, weight) => {
      const value = String(token ?? '').trim();
      if (value.length < 2) return;
      const anchorId = repo.upsertAnchor(handle, ownerScope, {
        normalizedToken: value.toLowerCase(),
        displayToken: value,
        type,
        now: iso,
      });
      repo.linkAnchor(handle, ownerScope, newId, anchorId, { weight, role });
    };
    push(payload.subject, 'entity', 'subject', 1);
    push(payload.object, 'topic', 'object', 1);
    for (const token of extractAnchorTokens(newText, { limit: 8 })) push(token, 'topic', 'topic', 0.5);

    repo.ftsUpsert(handle, newId, newText);
    repo.updateNode(handle, ownerScope, nodeId, { state: 'superseded', updated_at: iso });
    repo.insertEdge(handle, ownerScope, { fromNodeId: newId, toNodeId: nodeId, rel: 'supersedes', weight: 1, now: iso });
    repo.insertEdge(handle, ownerScope, { fromNodeId: newId, toNodeId: nodeId, rel: 'previous_version', weight: 1, now: iso });
    repo.recordEvent(handle, {
      ownerScope,
      op: 'correct_memory',
      targetId: newId,
      result: 'corrected',
      detail: { superseded: nodeId },
      now: iso,
    });
  });

  return {
    ok: true,
    newNodeId: newId,
    supersededNodeId: nodeId,
    relation: 'supersedes',
    rejected: rejected.length > 0 ? rejected : undefined,
  };
}

// ── 确认 / 否定 ─────────────────────────────────────────────────────────────

/**
 * 确认或否定一条 pending 记忆。
 * 明确规则：**"用户没回应"绝不等于确认**（计划书 §10.5）。
 */
export function confirmMemory(handle, cfg, ownerScope, { nodeId, confirmed, now = new Date() }) {
  const iso = nowIso(now);
  const node = repo.getNode(handle, ownerScope, nodeId);
  if (!node) return { ok: false, error: 'not_found', nodeId };
  if (node.state === 'deleted') return { ok: false, error: 'node_deleted', nodeId };
  if (confirmed !== true && confirmed !== false) return { ok: false, error: 'confirmed_must_be_boolean' };
  if (node.state !== 'pending_confirm') {
    return { ok: false, error: 'not_pending', state: node.state, hint: '只有 pending_confirm 状态的记忆需要确认' };
  }

  transaction(handle, () => {
    if (confirmed) {
      const boost = Math.min(1, Number(node.strength_base ?? 1) + cfg.strength.recallBoost);
      repo.updateNode(handle, ownerScope, nodeId, {
        state: 'active',
        last_confirmed_at: iso,
        strength_base: boost,
        strength_base_at: iso,
        updated_at: iso,
      });
      repo.recordEvent(handle, { ownerScope, op: 'confirm_memory', targetId: nodeId, result: 'confirmed', now: iso });
    } else {
      repo.updateNode(handle, ownerScope, nodeId, { state: 'cancelled', updated_at: iso });
      repo.recordEvent(handle, { ownerScope, op: 'confirm_memory', targetId: nodeId, result: 'rejected', now: iso });
    }
  });

  return { ok: true, nodeId, state: confirmed ? 'active' : 'cancelled' };
}

// ── 查看 ────────────────────────────────────────────────────────────────────

/**
 * 分页列出记忆。默认不返回被删除内容。
 */
export function listMemories(handle, cfg, ownerScope, filter = {}) {
  const page = repo.listNodes(handle, ownerScope, filter);
  return {
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    memories: page.rows.map((row) => ({
      node_id: row.node_id,
      memory_type: row.memory_type,
      tier: row.tier,
      stage: row.stage,
      state: row.state,
      summary: row.summary,
      sensitivity: row.sensitivity,
      source_type: row.source_type,
      confidence: row.extraction_confidence,
      valid_until: row.valid_until,
      last_confirmed_at: row.last_confirmed_at,
      created_at: row.created_at,
      payload: row.state === 'deleted' ? null : row.payload,
    })),
  };
}

/** 单条详情（含锚点），供纠正/删除前确认目标。 */
export function getMemoryDetail(handle, ownerScope, nodeId) {
  const node = repo.getNode(handle, ownerScope, nodeId);
  if (!node) return null;
  return { ...node, anchors: repo.anchorsOfNode(handle, ownerScope, nodeId) };
}

export { RECALLABLE_STATES, fingerprint, normalizeText };
