/**
 * 仓储层：所有 SQL 都集中在这里，全部使用参数化查询，所有查询都限定 owner_scope。
 *
 * 约定：
 *  - 函数都是同步的（node:sqlite 是同步 API），失败就抛错，不吞异常。
 *  - 写操作一律由上层包在 transaction() 里；本层不自己开事务，避免嵌套语义混乱。
 *  - FTS 的 `toks` 列由 tokenize.tokenText() 生成，写入/更新/删除必须同步维护。
 */

import { newAnchorId, newNodeId, newEventId } from './models.js';
import { tokenText, ftsExpression, anchorCandidates, normalizeText } from './tokenize.js';

const NODE_COLUMNS = `node_id, owner_scope, payload_json, canonical_text, summary, memory_type, tier, stage, state,
  extraction_confidence, source_confidence, source_type, source_ref, strength_base, strength_base_at,
  last_recalled_at, last_confirmed_at, valid_from, valid_until, supersedes_node_id, sensitivity,
  created_at, updated_at, deleted_at, purge_pending, dedupe_key, topic_key`;

function parsePayload(row) {
  const out = { ...row };
  if (row.payload_json === null || row.payload_json === undefined) {
    out.payload = null;
  } else {
    try {
      out.payload = JSON.parse(row.payload_json);
    } catch {
      out.payload = null;
      out.payload_corrupt = true;
    }
  }
  delete out.payload_json;
  return out;
}

/** 插入一个记忆节点。 */
export function insertNode(handle, node) {
  handle.db
    .prepare(
      `INSERT INTO memory_nodes (${NODE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      node.node_id ?? newNodeId(),
      node.owner_scope,
      node.payload_json ?? null,
      node.canonical_text ?? null,
      node.summary ?? null,
      node.memory_type,
      node.tier,
      node.stage,
      node.state,
      node.extraction_confidence ?? 0,
      node.source_confidence ?? 0,
      node.source_type,
      node.source_ref ?? null,
      node.strength_base ?? 1,
      node.strength_base_at,
      node.last_recalled_at ?? null,
      node.last_confirmed_at ?? null,
      node.valid_from ?? null,
      node.valid_until ?? null,
      node.supersedes_node_id ?? null,
      node.sensitivity ?? 'normal',
      node.created_at,
      node.updated_at,
      node.deleted_at ?? null,
      node.purge_pending ?? 0,
      node.dedupe_key ?? null,
      node.topic_key ?? null,
    );
  return node.node_id;
}

/** 按 ID 读取节点（含 scope 校验）。 */
export function getNode(handle, ownerScope, nodeId) {
  const row = handle.db
    .prepare(`SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE node_id = ? AND owner_scope = ?`)
    .get(nodeId, ownerScope);
  return row ? parsePayload(row) : null;
}

/** 通用字段更新（只允许白名单字段，避免把任意列名拼进 SQL）。 */
const UPDATABLE = new Set([
  'payload_json',
  'canonical_text',
  'summary',
  'memory_type',
  'tier',
  'stage',
  'state',
  'extraction_confidence',
  'source_confidence',
  'source_type',
  'source_ref',
  'strength_base',
  'strength_base_at',
  'last_recalled_at',
  'last_confirmed_at',
  'valid_from',
  'valid_until',
  'supersedes_node_id',
  'sensitivity',
  'updated_at',
  'deleted_at',
  'purge_pending',
  'dedupe_key',
  'topic_key',
]);

export function updateNode(handle, ownerScope, nodeId, patch) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE.has(key)) throw new Error(`updateNode: 不允许更新字段 ${key}`);
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return 0;
  const result = handle.db
    .prepare(`UPDATE memory_nodes SET ${fields.join(', ')} WHERE node_id = ? AND owner_scope = ?`)
    .run(...values, nodeId, ownerScope);
  return Number(result.changes ?? 0);
}

/** 锚点 upsert：同 scope 内 normalized_token 唯一。 */
export function upsertAnchor(handle, ownerScope, { normalizedToken, displayToken, type, now }) {
  const existing = handle.db
    .prepare('SELECT anchor_id, state FROM anchors WHERE owner_scope = ? AND normalized_token = ?')
    .get(ownerScope, normalizedToken);
  if (existing) {
    if (existing.state !== 'active') {
      handle.db.prepare("UPDATE anchors SET state = 'active', type = ? WHERE anchor_id = ?").run(type, existing.anchor_id);
    }
    return existing.anchor_id;
  }
  const anchorId = newAnchorId();
  handle.db
    .prepare(
      `INSERT INTO anchors (anchor_id, owner_scope, normalized_token, display_token, type, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(anchorId, ownerScope, normalizedToken, displayToken, type, now);
  return anchorId;
}

export function linkAnchor(handle, ownerScope, nodeId, anchorId, { weight = 1, role = 'topic' } = {}) {
  handle.db
    .prepare(
      `INSERT INTO node_anchors (node_id, anchor_id, owner_scope, weight, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (node_id, anchor_id) DO UPDATE SET weight = excluded.weight, role = excluded.role`,
    )
    .run(nodeId, anchorId, ownerScope, weight, role);
}

export function anchorsOfNode(handle, ownerScope, nodeId) {
  return handle.db
    .prepare(
      `SELECT a.anchor_id, a.normalized_token, a.display_token, a.type, na.weight, na.role
       FROM node_anchors na JOIN anchors a ON a.anchor_id = na.anchor_id
       WHERE na.node_id = ? AND na.owner_scope = ?
       ORDER BY na.weight DESC, a.normalized_token`,
    )
    .all(nodeId, ownerScope);
}

export function insertEdge(handle, ownerScope, { fromNodeId, toNodeId, rel, weight = 1, now }) {
  handle.db
    .prepare(
      `INSERT INTO memory_edges (edge_id, owner_scope, from_node_id, to_node_id, rel, weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_scope, from_node_id, to_node_id, rel)
       DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
    )
    .run(`E_${fromNodeId}_${toNodeId}_${rel}`.slice(0, 96), ownerScope, fromNodeId, toNodeId, rel, weight, now, now);
}

export function edgesOf(handle, ownerScope, nodeId) {
  return handle.db
    .prepare(
      `SELECT edge_id, from_node_id, to_node_id, rel, weight FROM memory_edges
       WHERE owner_scope = ? AND (from_node_id = ? OR to_node_id = ?)`,
    )
    .all(ownerScope, nodeId, nodeId);
}

// ── 全文索引 ────────────────────────────────────────────────────────────────

export function ftsUpsert(handle, nodeId, text) {
  ftsDelete(handle, nodeId);
  const toks = tokenText(text);
  if (toks.length === 0) return;
  handle.db.prepare('INSERT INTO memory_fts (node_id, toks) VALUES (?, ?)').run(nodeId, toks);
}

export function ftsDelete(handle, nodeId) {
  handle.db.prepare('DELETE FROM memory_fts WHERE node_id = ?').run(nodeId);
}

/**
 * 全文检索候选。
 * @param {string[]} [states] - 允许出现的内存状态；历史查询需要传非 active 的状态
 * @returns {Array<{ node_id: string, rank: number }>} rank 为 bm25（越小越相关）
 */
export function searchFts(handle, ownerScope, query, limit, states = ['active']) {
  const expr = ftsExpression(query);
  if (!expr) return [];
  const stateList = states.length > 0 ? states : ['active'];
  const placeholders = stateList.map(() => '?').join(', ');
  const rows = handle.db
    .prepare(
      `SELECT f.node_id AS node_id, bm25(memory_fts) AS rank
       FROM memory_fts f
       JOIN memory_nodes n ON n.node_id = f.node_id
       WHERE memory_fts MATCH ? AND n.owner_scope = ? AND n.state IN (${placeholders})
       ORDER BY rank
       LIMIT ?`,
    )
    .all(expr, ownerScope, ...stateList, limit);
  return rows.map((row) => ({ node_id: row.node_id, rank: Number(row.rank) }));
}

/**
 * 锚点检索候选，按**区分度加权**后排序。
 *
 * 为什么要做 IDF：同一实体（如"成都"）可能挂在很多条记忆上。如果按命中锚点数/权重
 * 直接排序，一个"说了成都天气"的记忆会和"下周去成都出差"得分一样高，导致
 * 同一个实体的无关记忆被一起注入（在标注集上实测无关注入率 27.8%）。
 * 所以每个锚点按它在本 scope 内的稀有度打一个 specificity 系数：
 *   specificity = 1 - df / (活跃节点总数 + 1)
 * 只有该记忆独占的锚点才接近 1；所有记忆共享的通用锚点接近 0。
 *
 * @param {string[]} [states] - 允许出现的内存状态
 * @returns {Array<{ node_id: string, hits: number, weight: number, specificity: number }>}
 */
export function searchAnchors(handle, ownerScope, query, limit, states = ['active']) {
  const tokens = anchorCandidates(query);
  if (tokens.length === 0) return [];
  const stateList = states.length > 0 ? states : ['active'];
  const statePlaceholders = stateList.map(() => '?').join(', ');
  const totalNodes = handle.db
    .prepare(`SELECT COUNT(*) AS c FROM memory_nodes WHERE owner_scope = ? AND state IN (${statePlaceholders})`)
    .get(ownerScope, ...stateList).c;
  const denominator = Math.max(1, Number(totalNodes) + 1);

  const aggregated = new Map();
  const CHUNK = 100;
  for (let start = 0; start < tokens.length; start += CHUNK) {
    const slice = tokens.slice(start, start + CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    // 一条 SQL 同时算 document frequency 与区分度加权，并只返回 top-limit。
    // 早期版本把命中的 node_anchors 行全取回 JS 聚合：通用锚点有几千条关系时
    // 单次召回要传几万行（实测 P95 93ms）。聚合下推后只回传 limit 行。
    const rows = handle.db
      .prepare(
        `WITH ha AS (
           SELECT anchor_id FROM anchors
           WHERE owner_scope = ? AND state = 'active' AND normalized_token IN (${placeholders})
         ),
         df AS (
           SELECT na2.anchor_id AS aid, COUNT(*) AS c
           FROM node_anchors na2
           JOIN memory_nodes n2 ON n2.node_id = na2.node_id
           WHERE na2.owner_scope = ? AND na2.anchor_id IN (SELECT anchor_id FROM ha)
             AND n2.state IN (${statePlaceholders})
           GROUP BY na2.anchor_id
         )
         SELECT na.node_id AS node_id,
                COUNT(*) AS hits,
                SUM(na.weight) AS weight,
                SUM(na.weight * (1.0 - MIN(1.0, CAST(df.c AS REAL) / ?))) AS specificity
         FROM ha
         CROSS JOIN node_anchors na ON na.anchor_id = ha.anchor_id
         JOIN df ON df.aid = ha.anchor_id
         JOIN memory_nodes n ON n.node_id = na.node_id
         WHERE na.owner_scope = ? AND n.state IN (${statePlaceholders})
         GROUP BY na.node_id
         ORDER BY specificity DESC, hits DESC
         LIMIT ?`,
      )
      .all(ownerScope, ...slice, ownerScope, ...stateList, denominator, ownerScope, ...stateList, limit);
    for (const row of rows) {
      const specificity = Math.min(1, Number(row.specificity));
      const prev = aggregated.get(row.node_id);
      if (prev) {
        prev.hits += Number(row.hits);
        prev.weight += Number(row.weight);
        prev.specificity = Math.min(1, prev.specificity + specificity);
      } else {
        aggregated.set(row.node_id, {
          node_id: row.node_id,
          hits: Number(row.hits),
          weight: Number(row.weight),
          specificity,
        });
      }
    }
  }
  return [...aggregated.values()]
    .sort((a, b) => b.specificity - a.specificity || b.hits - a.hits)
    .slice(0, limit);
}

/** 一次取出若干节点的完整行（用于候选过滤与注入载荷）。 */
export function getNodes(handle, ownerScope, nodeIds) {
  if (nodeIds.length === 0) return [];
  const out = [];
  const CHUNK = 200;
  for (let start = 0; start < nodeIds.length; start += CHUNK) {
    const slice = nodeIds.slice(start, start + CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    const rows = handle.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE owner_scope = ? AND node_id IN (${placeholders})`)
      .all(ownerScope, ...slice);
    out.push(...rows.map(parsePayload));
  }
  return out;
}

/** 通过 `same_topic` 等边扩展 1 跳邻居（只返回仍可召回的节点）。 */
export function expandNeighbors(handle, ownerScope, nodeIds, limit) {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => '?').join(', ');
  const rows = handle.db
    .prepare(
      `SELECT e.to_node_id AS node_id, e.rel, e.weight
       FROM memory_edges e
       JOIN memory_nodes n ON n.node_id = e.to_node_id
       WHERE e.owner_scope = ? AND e.from_node_id IN (${placeholders}) AND n.state = 'active'
       ORDER BY e.weight DESC
       LIMIT ?`,
    )
    .all(ownerScope, ...nodeIds, limit);
  return rows.map((row) => ({ node_id: row.node_id, rel: row.rel, weight: Number(row.weight) }));
}

/** 分页列出记忆（控制台/工具用）。 */
export function listNodes(handle, ownerScope, filter = {}) {
  const where = ['owner_scope = ?'];
  const params = [ownerScope];
  if (filter.includeDeleted) {
    // 显式要求时才包含 deleted；默认永不返回被删内容。
  } else {
    where.push("state <> 'deleted'");
  }
  for (const [field, column] of [
    ['memoryType', 'memory_type'],
    ['tier', 'tier'],
    ['state', 'state'],
    ['stage', 'stage'],
  ]) {
    const value = filter[field];
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  if (filter.keyword) {
    where.push('(canonical_text LIKE ? OR summary LIKE ?)');
    const like = `%${filter.keyword}%`;
    params.push(like, like);
  }
  if (filter.createdAfter) {
    where.push('created_at >= ?');
    params.push(filter.createdAfter);
  }
  if (filter.createdBefore) {
    where.push('created_at <= ?');
    params.push(filter.createdBefore);
  }
  const limit = Math.min(Math.max(Number(filter.limit) || 20, 1), 200);
  const offset = Math.max(Number(filter.offset) || 0, 0);
  const total = handle.db.prepare(`SELECT COUNT(*) AS c FROM memory_nodes WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = handle.db
    .prepare(
      `SELECT ${NODE_COLUMNS} FROM memory_nodes WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, node_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { total, limit, offset, rows: rows.map(parsePayload) };
}

/** 只有在**实际注入**之后才更新 last_recalled_at（计划书 §8.1 第 9 步）。 */
export function markRecalled(handle, ownerScope, nodeIds, at) {
  if (nodeIds.length === 0) return 0;
  const stmt = handle.db.prepare(
    'UPDATE memory_nodes SET last_recalled_at = ? WHERE node_id = ? AND owner_scope = ?',
  );
  let changed = 0;
  for (const nodeId of nodeIds) changed += Number(stmt.run(at, nodeId, ownerScope).changes ?? 0);
  return changed;
}

/** 记录操作审计（不含正文）。 */
export function recordEvent(handle, { ownerScope, op, targetId = null, result, errorCode = null, detail = null, now }) {
  handle.db
    .prepare(
      `INSERT INTO memory_events (event_id, owner_scope, op, target_id, result, error_code, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newEventId(), ownerScope, op, targetId, result, errorCode, detail ? JSON.stringify(detail) : null, now);
}

export function recentEvents(handle, ownerScope, limit = 20) {
  return handle.db
    .prepare(
      `SELECT event_id, op, target_id, result, error_code, detail_json, created_at
       FROM memory_events WHERE owner_scope = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(ownerScope, limit);
}

export function insertStat(handle, ownerScope, kind, value, now) {
  handle.db
    .prepare('INSERT INTO recall_stats (stat_id, owner_scope, kind, value, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`S_${Math.random().toString(36).slice(2, 12)}`, ownerScope, kind, value, now);
}

export function statsBetween(handle, kind, fromIso, toIso) {
  return handle.db
    .prepare('SELECT value FROM recall_stats WHERE kind = ? AND created_at >= ? AND created_at <= ?')
    .all(kind, fromIso, toIso)
    .map((row) => Number(row.value));
}

export function setMeta(handle, key, value) {
  handle.db
    .prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(handle, key) {
  const row = handle.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

// ── 删除抑制标记 ────────────────────────────────────────────────────────────

export function insertForgetMarker(handle, ownerScope, kind, value, now) {
  handle.db
    .prepare(
      `INSERT INTO forget_markers (marker_id, owner_scope, marker_kind, marker_value, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_scope, marker_kind, marker_value) DO NOTHING`,
    )
    .run(`F_${value.slice(0, 24)}`, ownerScope, kind, value, now);
}

export function hasForgetMarker(handle, ownerScope, kind, value) {
  return Boolean(
    handle.db
      .prepare('SELECT 1 AS x FROM forget_markers WHERE owner_scope = ? AND marker_kind = ? AND marker_value = ?')
      .get(ownerScope, kind, value),
  );
}

export function deleteForgetMarkersOfKind(handle, ownerScope, kind) {
  return Number(
    handle.db.prepare('DELETE FROM forget_markers WHERE owner_scope = ? AND marker_kind = ?').run(ownerScope, kind).changes ?? 0,
  );
}

// ── 任务锁 ──────────────────────────────────────────────────────────────────

export function acquireLock(handle, name, holder, { now, ttlMs }) {
  const nowIso = now;
  const expires = new Date(new Date(now).getTime() + ttlMs).toISOString();
  // 先清掉过期锁，再尝试插入；插入冲突说明别人持有。
  handle.db.prepare('DELETE FROM task_locks WHERE name = ? AND expires_at <= ?').run(name, nowIso);
  try {
    handle.db
      .prepare('INSERT INTO task_locks (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(name, holder, nowIso, expires);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(handle, name, holder) {
  handle.db.prepare('DELETE FROM task_locks WHERE name = ? AND holder = ?').run(name, holder);
}

export function startRun(handle, kind, now) {
  const runId = `R_${Math.random().toString(36).slice(2, 12)}`;
  handle.db
    .prepare('INSERT INTO maintenance_runs (run_id, kind, started_at) VALUES (?, ?, ?)')
    .run(runId, kind, now);
  return runId;
}

export function finishRun(handle, runId, { processed, failed, errorCode = null, detail = null, now }) {
  handle.db
    .prepare(
      `UPDATE maintenance_runs SET finished_at = ?, processed = ?, failed = ?, error_code = ?, detail_json = ?
       WHERE run_id = ?`,
    )
    .run(now, processed, failed, errorCode, detail ? JSON.stringify(detail) : null, runId);
}

export function lastRuns(handle, limit = 10) {
  return handle.db
    .prepare('SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit);
}

export function normalizeForStorage(text) {
  return normalizeText(text);
}
