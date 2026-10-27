/**
 * 强度衰减与候选排序（计划书 §8.2 / §9.1）。
 *
 * 这里**刻意不加权图中心性、不做自动参数学习**：第一版要的是可解释、可测试。
 * 所有系数都写在函数顶部并集中暴露，方便用标注集调参（调参结果见 TEST-REPORT）。
 */

const DAY_MS = 86400000;

export const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 各来源类型的可信度权重。用户明确陈述 > 导入 > Agent 推断 > Agent 生成。 */
export const SOURCE_TRUST = Object.freeze({
  user_explicit: 1.0,
  imported: 0.85,
  user_inferred: 0.65,
  agent_generated: 0.45,
});

/** 各状态的可注入资格。非 active 一律不自动注入。 */
export const STATE_ELIGIBILITY = Object.freeze({
  active: 1.0,
  pending_confirm: 0.0, // 待确认内容默认不进入普通回复注入（计划书 §7.2）
  superseded: 0.0,
  cancelled: 0.0,
  expired: 0.0,
  deleted: 0.0,
});

/**
 * 幂函数强度衰减。
 * strength(t) = base * (1 + elapsed_days / tau)^(-alpha)
 *
 * 关键实现约束：`base` 对应 `baseAt`，**只按时间单向计算**，不把衰减后的值写回 `base`，
 * 否则会重复衰减（计划书 §9.1 明令禁止）。
 *
 * @param {{ tier: string, strength_base: number, strength_base_at: string }} node
 * @param {Date} now
 * @param {object} strengthCfg - cfg.strength
 * @returns {number} 0..1
 */
export function effectiveStrength(node, now, strengthCfg) {
  const params = strengthCfg[node.tier] ?? strengthCfg.normal;
  const base = clamp01(Number(node.strength_base ?? 1));
  const baseAt = new Date(node.strength_base_at ?? node.created_at ?? now).getTime();
  if (!Number.isFinite(baseAt)) return base;
  const elapsedDays = Math.max(0, (now.getTime() - baseAt) / DAY_MS);
  const decayed = base * Math.pow(1 + elapsedDays / params.tauDays, -params.alpha);
  return clamp01(decayed);
}

/**
 * 把 bm25（越小越相关）映射成 0..1 的词面匹配度。
 * FTS5 的 bm25 是负数且无固定下界，这里用单调映射：-rank/(1-rank) 再夹到 [0,1]。
 * @param {number} rank - bm25 原值
 */
export function lexicalScoreFromRank(rank) {
  if (!Number.isFinite(rank)) return 0;
  const positive = Math.max(0, -rank);
  return clamp01(positive / (positive + 1));
}

/**
 * 计算相关度（不含可信度/强度，便于分开观察）。
 *
 * 与计划书 §8.2 的示意公式相比，这里做了一处**有实测依据**的结构调整：
 * 示意公式是五项线性加权，其中"意图 / 时间 / 新近"三项对任何节点都能拿到
 * 0.3~0.5 分，于是**完全没匹配上的记忆也能拿到 0.15 左右的相关度**，
 * 在任何合理阈值下都会被注入（在标注集上实测无关注入率 27.8%）。
 *
 * 现在的形式是"匹配强度 × 上下文加成"：
 *   match   = 0.55*anchor + 0.45*lexical        （只有真的匹配上才可能 > 0）
 *   context = 0.45*intent + 0.30*temporal + 0.25*recency
 *   score   = match * (0.75 + 0.25*context)     （上下文只放大已有匹配，最大 +25%）
 * 这样"新近但无关"和"意图沾边但没匹配"都不会被注入。
 * 调参前后对比见 docs/TEST-REPORT.md。
 *
 * @param {{ anchorMatch: number, lexicalMatch: number, intentMatch: number, temporalMatch: number, recencyMatch: number }} features
 */
export function relevanceOf(features) {
  const anchor = clamp01(features.anchorMatch ?? 0);
  const lexical = clamp01(features.lexicalMatch ?? 0);
  const intent = clamp01(features.intentMatch ?? 0);
  const temporal = clamp01(features.temporalMatch ?? 0);
  const recency = clamp01(features.recencyMatch ?? 0);
  const match = clamp01(0.55 * anchor + 0.45 * lexical);
  const context = clamp01(0.45 * intent + 0.3 * temporal + 0.25 * recency);
  const score = clamp01(match * (0.75 + 0.25 * context));
  return { score, parts: { anchor, lexical, intent, temporal, recency, match, context } };
}

/**
 * 可信度因子：来源可信度与抽取置信度的均值。
 * 这是"内容是否可信"，与 relevance（"是否相关"）严格分离 —— 语义相似不等于事实正确。
 */
export function confidenceFactor(node) {
  const trust = SOURCE_TRUST[node.source_type] ?? 0.5;
  const extraction = clamp01(Number(node.extraction_confidence ?? 0));
  return clamp01((trust + extraction) / 2);
}

/**
 * 最终分数。
 * final = relevance * confidence_factor * (0.60 + 0.40 * effective_strength) * state_eligibility
 */
export function finalScore({ node, features, now, strengthCfg }) {
  const { score: relevance, parts } = relevanceOf(features);
  const confidence = confidenceFactor(node);
  const strength = effectiveStrength(node, now, strengthCfg);
  const eligibility = STATE_ELIGIBILITY[node.state] ?? 0;
  const score = relevance * confidence * (0.6 + 0.4 * strength) * eligibility;
  return { score, relevance, confidence, strength, eligibility, parts };
}

/**
 * 时间/状态匹配度。
 *  - 有 valid_until 且已过期 -> 0（普通查询不该命中过期计划）
 *  - 查询里出现时间表达且与记忆 when 相近 -> 加分
 */
export function temporalMatch(node, now, queryDate = null) {
  const until = node.valid_until ? new Date(node.valid_until).getTime() : null;
  if (until !== null && Number.isFinite(until) && until < now.getTime()) return 0;
  const payloadWhen = node.payload?.when ? new Date(node.payload.when).getTime() : null;
  if (queryDate !== null && Number.isFinite(queryDate) && payloadWhen !== null && Number.isFinite(payloadWhen)) {
    const diffDays = Math.abs(payloadWhen - queryDate) / DAY_MS;
    if (diffDays <= 1) return 1;
    if (diffDays <= 7) return 0.7;
    if (diffDays <= 31) return 0.4;
    return 0.1;
  }
  return 0.5;
}

/** 新近度：以 180 天为半衰期的简单线性衰减。 */
export function recencyMatch(node, now, halfLifeDays = 180) {
  const created = new Date(node.created_at ?? now).getTime();
  if (!Number.isFinite(created)) return 0;
  const days = Math.max(0, (now.getTime() - created) / DAY_MS);
  return clamp01(1 / (1 + days / halfLifeDays));
}

/**
 * 意图匹配度：当前问题想找的"记忆类型"是否与节点类型一致。
 * @param {string} intent - 由 retriever 推断的意图
 * @param {object} node
 */
export function intentMatch(intent, node) {
  if (!intent) return 0.5;
  const map = {
    preference: ['preference', 'fact'],
    fact: ['fact', 'event', 'correction'],
    plan: ['plan', 'task', 'commitment'],
    correction: ['correction', 'fact'],
    event: ['event', 'plan'],
  };
  const wanted = map[intent] ?? [];
  if (wanted.includes(node.memory_type)) return 1;
  return 0.3;
}

/** 阶段 -> 注入表示精细度对应的字段裁剪方式（阶段不是删除，只决定表示）。 */
export function projectStage(node, stage) {
  const payload = node.payload ?? {};
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]));
  switch (stage) {
    case 'full':
      return { payload, summary: node.summary };
    case 'summary':
      return { payload: pick('subject', 'action', 'object', 'when', 'status'), summary: node.summary };
    case 'keyword':
      return {
        payload: pick('subject', 'action', 'object', 'status'),
        summary: null,
      };
    case 'anchor':
      return { payload: pick('subject', 'object'), summary: null };
    default:
      return { payload: pick('subject', 'action', 'object'), summary: null };
  }
}
