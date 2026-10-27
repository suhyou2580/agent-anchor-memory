/**
 * 写入管线（计划书 §7）。
 *
 * 顺序：抽取 -> 隐私闸门 -> 置信度路由 -> 去重发现 -> 节点+锚点+边（同事务）-> FTS -> 审计。
 * 事务边界由调用方（service）提供，本模块内的多次写操作必须原子完成。
 */

import * as repo from './repository.js';
import { extractCandidates, anchorsForCandidate, privacyGate } from './extractor.js';
import { newNodeId, toIso } from './models.js';
import { topicFingerprint } from './tokenize.js';

/** 新节点默认强度基准。 */
const INITIAL_STRENGTH = 1.0;

function buildDedupeKey(candidate) {
  const payload = candidate.payload ?? {};
  return topicFingerprint([
    candidate.memoryType,
    payload.subject ?? '',
    payload.object ?? '',
    candidate.when ?? '',
  ]);
}

/** 主题指纹（不含时间）：用来发现"同一件事的新状态"。 */
function buildTopicKey(candidate) {
  const payload = candidate.payload ?? {};
  return topicFingerprint([candidate.memoryType, payload.subject ?? '', payload.object ?? '']);
}

function contradictingStatus(oldStatus, newStatus) {
  const terminal = new Set(['cancelled', 'completed']);
  const pendingish = new Set(['considering', 'planned', 'confirmed', 'undecided', 'unknown']);
  if (oldStatus === newStatus) return false;
  if (terminal.has(newStatus) && pendingish.has(oldStatus)) return true;
  if (newStatus === 'confirmed' && oldStatus === 'considering') return true;
  return false;
}

/**
 * 写入单个候选。调用方必须已在事务中。
 * @returns {{ nodeId: string, state: string, anchors: object[], pendingConfirm: boolean, duplicateOf: string|null, superseded: string|null }}
 */
export function writeCandidate(handle, cfg, ownerScope, candidate, { now = new Date(), sourceRef = null } = {}) {
  const nowIso = now.toISOString();
  const gate = privacyGate(candidate, cfg);
  if (!gate.allow) {
    repo.recordEvent(handle, {
      ownerScope,
      op: 'write_memory',
      targetId: null,
      result: 'rejected',
      errorCode: gate.reason,
      now: nowIso,
    });
    return { nodeId: null, state: 'rejected', anchors: [], pendingConfirm: false, duplicateOf: null, superseded: null, reason: gate.reason };
  }

  // ── 置信度路由（计划书 §7.2）──
  let state;
  if (candidate.requestedState === 'active') state = 'active';
  else if (candidate.confidence >= cfg.confidence.activeWriteThreshold) state = 'active';
  else if (candidate.confidence >= cfg.confidence.pendingThreshold) state = 'pending_confirm';
  else {
    repo.recordEvent(handle, {
      ownerScope,
      op: 'write_memory',
      targetId: null,
      result: 'discarded',
      errorCode: 'below_confidence_threshold',
      detail: { confidence: candidate.confidence },
      now: nowIso,
    });
    return { nodeId: null, state: 'discarded', anchors: [], pendingConfirm: false, duplicateOf: null, superseded: null, reason: 'below_confidence_threshold' };
  }

  const dedupeKey = buildDedupeKey(candidate);
  const topicKey = buildTopicKey(candidate);
  const exact = findExactDuplicate(handle, ownerScope, dedupeKey, candidate);
  const sameTopic = exact ?? findSameTopic(handle, ownerScope, topicKey, candidate);

  // 完全重复：不新增行，只更新确认时间与强度基准（避免同一句话存十份）。
  if (exact && !contradictingStatus(exact.payload?.status, candidate.payload?.status)) {
    repo.updateNode(handle, ownerScope, exact.node_id, {
      last_confirmed_at: nowIso,
      strength_base: Math.min(1, Number(exact.strength_base) + 0.05),
      strength_base_at: nowIso,
      updated_at: nowIso,
    });
    repo.recordEvent(handle, {
      ownerScope,
      op: 'write_memory',
      targetId: exact.node_id,
      result: 'deduplicated',
      now: nowIso,
    });
    return {
      nodeId: exact.node_id,
      state: exact.state,
      anchors: repo.anchorsOfNode(handle, ownerScope, exact.node_id),
      pendingConfirm: exact.state === 'pending_confirm',
      duplicateOf: exact.node_id,
      superseded: null,
      reason: null,
    };
  }

  // 只有"同主题 + 状态发生实质矛盾（取消/完成/从考虑变为确认）"才替代旧节点；
  // 同主题但状态不矛盾的（例如不同日期的两次出行计划）各自保留，绝不自动合并。
  const supersedeTarget = sameTopic && contradictingStatus(sameTopic.payload?.status, candidate.payload?.status)
    ? sameTopic
    : null;

  const nodeId = newNodeId();
  const supersededId = supersedeTarget ? supersedeTarget.node_id : null;

  repo.insertNode(handle, {
    node_id: nodeId,
    owner_scope: ownerScope,
    payload_json: candidate.payload ? JSON.stringify(candidate.payload) : null,
    canonical_text: candidate.canonicalText,
    summary: candidate.summary,
    memory_type: candidate.memoryType,
    tier: candidate.tier,
    stage: 'full',
    state,
    extraction_confidence: candidate.confidence,
    source_confidence: sourceTrustOf(candidate.sourceType),
    source_type: candidate.sourceType,
    source_ref: sourceRef ?? candidate.sourceRef ?? null,
    strength_base: INITIAL_STRENGTH,
    strength_base_at: nowIso,
    last_confirmed_at: candidate.explicit ? nowIso : null,
    valid_from: candidate.validFrom ?? toIso(candidate.createdAt ?? nowIso),
    valid_until: candidate.validUntil ?? null,
    supersedes_node_id: supersededId,
    sensitivity: gate.sensitivity,
    created_at: nowIso,
    updated_at: nowIso,
    dedupe_key: dedupeKey,
    topic_key: topicKey,
  });

  const anchors = anchorsForCandidate(candidate);
  for (const anchor of anchors) {
    const anchorId = repo.upsertAnchor(handle, ownerScope, {
      normalizedToken: anchor.token.toLowerCase(),
      displayToken: anchor.token,
      type: anchor.type,
      now: nowIso,
    });
    repo.linkAnchor(handle, ownerScope, nodeId, anchorId, { weight: anchor.weight, role: anchor.role });
  }

  // 纠错 / 状态变更：旧节点立刻退出普通召回，并留下版本关系。
  if (supersededId) {
    repo.updateNode(handle, ownerScope, supersededId, {
      state: candidate.payload?.status === 'cancelled' ? 'cancelled' : 'superseded',
      updated_at: nowIso,
    });
    repo.insertEdge(handle, ownerScope, {
      fromNodeId: nodeId,
      toNodeId: supersededId,
      rel: 'supersedes',
      weight: 1,
      now: nowIso,
    });
    repo.insertEdge(handle, ownerScope, {
      fromNodeId: nodeId,
      toNodeId: supersededId,
      rel: 'previous_version',
      weight: 1,
      now: nowIso,
    });
  }

  repo.ftsUpsert(handle, nodeId, `${candidate.canonicalText} ${candidate.summary ?? ''}`);
  repo.recordEvent(handle, {
    ownerScope,
    op: 'write_memory',
    targetId: nodeId,
    result: state === 'pending_confirm' ? 'pending_confirm' : 'written',
    detail: { memory_type: candidate.memoryType, tier: candidate.tier, confidence: candidate.confidence },
    now: nowIso,
  });

  return {
    nodeId,
    state,
    anchors: repo.anchorsOfNode(handle, ownerScope, nodeId),
    pendingConfirm: state === 'pending_confirm',
    duplicateOf: null,
    superseded: supersededId,
    reason: null,
  };
}

function sourceTrustOf(sourceType) {
  return { user_explicit: 1.0, imported: 0.85, user_inferred: 0.65, agent_generated: 0.45 }[sourceType] ?? 0.5;
}

/**
 * 精确重复：同 scope、同 dedupe_key（含时间）、仍 active/pending 的最新节点。
 * 注意这只是"发现候选"，真正合并/替代由调用方的语义判断决定（计划书 §7.4）。
 */
function findExactDuplicate(handle, ownerScope, dedupeKey, candidate) {
  const row = handle.db
    .prepare(
      `SELECT * FROM memory_nodes
       WHERE owner_scope = ? AND dedupe_key = ? AND state IN ('active','pending_confirm')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ownerScope, dedupeKey);
  if (!row) return null;
  // 只有主题与类型都一致才算同一个记忆的重复陈述。
  if (row.memory_type !== candidate.memoryType) return null;
  return { ...row, payload: row.payload_json ? safeParse(row.payload_json) : {} };
}

/** 同主题（忽略时间）的活跃节点，用于发现"计划被取消/完成"这类状态变更。 */
function findSameTopic(handle, ownerScope, topicKey, candidate) {
  const row = handle.db
    .prepare(
      `SELECT * FROM memory_nodes
       WHERE owner_scope = ? AND topic_key = ? AND state IN ('active','pending_confirm')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ownerScope, topicKey);
  if (!row) return null;
  if (row.memory_type !== candidate.memoryType) return null;
  return { ...row, payload: row.payload_json ? safeParse(row.payload_json) : {} };
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * 从一条文本抽取并写入全部候选（对应 `write_memory` 工具）。
 * @returns {{ written: object[], rejected: object[] }}
 */
export function writeText(handle, cfg, ownerScope, rawText, options = {}) {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const { candidates, rejected } = extractCandidates(rawText, {
    now,
    sourceType: options.sourceType ?? 'user_explicit',
    sourceRef: options.sourceRef ?? null,
  });

  // 只对"值得追溯"的拒绝留审计（凭据类 / 超长）；普通闲聊不算事件，
  // 否则每句聊天都会产生一条噪声记录。审计里不写正文。
  for (const item of rejected) {
    if (item.reason !== 'forbidden_credential' && item.reason !== 'too_long') continue;
    repo.recordEvent(handle, {
      ownerScope,
      op: 'write_memory',
      targetId: null,
      result: 'rejected',
      errorCode: item.reason,
      now: nowIso,
    });
  }

  // 遗忘抑制：同一来源被明确忘掉后，不允许被同一条消息再自动写回来（除非用户显式重新记住）。
  // 抑制标记只存 HMAC 指纹（见 control.forgetMemory），没有可用密钥时跳过该检查并明确报告。
  const hash = typeof options.hash === 'function' ? options.hash : null;
  const written = [];
  const suppressed = [];
  for (const candidate of candidates) {
    if (!candidate.explicit && hash && options.allowSuppressed !== true) {
      const marker = repo.hasForgetMarker(handle, ownerScope, 'topic_fingerprint', hash(suppressionFingerprint(candidate)));
      if (marker) {
        suppressed.push({ memoryType: candidate.memoryType, reason: 'forgotten_source' });
        continue;
      }
    }
    const result = writeCandidate(handle, cfg, ownerScope, candidate, { now, sourceRef: options.sourceRef });
    written.push({ ...result, memoryType: candidate.memoryType, confidence: candidate.confidence });
  }
  return { written, rejected, suppressed, suppressionChecked: Boolean(hash) };
}

/** 抑制指纹：主题+类型，不包含正文，便于 HMAC 后仍能匹配"同一话题再次出现"。 */
export function suppressionFingerprint(candidate) {
  const payload = candidate.payload ?? {};
  return `${candidate.memoryType}|${payload.subject ?? ''}|${payload.object ?? ''}`;
}
