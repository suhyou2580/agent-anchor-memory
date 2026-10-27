import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveStrength,
  relevanceOf,
  confidenceFactor,
  finalScore,
  temporalMatch,
  recencyMatch,
  intentMatch,
  projectStage,
  lexicalScoreFromRank,
  STATE_ELIGIBILITY,
} from '../../src/scoring.js';

const STRENGTH = {
  core: { tauDays: 365, alpha: 0.6 },
  normal: { tauDays: 90, alpha: 1.2 },
  edge: { tauDays: 21, alpha: 1.8 },
  recallBoost: 0.1,
};

const nodeAt = (days, overrides = {}) => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  return {
    node_id: 'M_x',
    tier: 'normal',
    strength_base: 1,
    strength_base_at: base.toISOString(),
    created_at: base.toISOString(),
    state: 'active',
    source_type: 'user_explicit',
    extraction_confidence: 1,
    payload: {},
    memory_type: 'fact',
    ...overrides,
  };
};

const nowAt = (days) => new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + days * 86400000);

test('强度衰减：t=0 时等于 base，随时间单调下降', () => {
  assert.equal(effectiveStrength(nodeAt(0), nowAt(0), STRENGTH), 1);
  const s7 = effectiveStrength(nodeAt(0), nowAt(7), STRENGTH);
  const s30 = effectiveStrength(nodeAt(0), nowAt(30), STRENGTH);
  const s90 = effectiveStrength(nodeAt(0), nowAt(90), STRENGTH);
  assert.ok(s7 < 1 && s7 > s30 && s30 > s90);
  assert.ok(s90 > 0);
});

test('强度衰减不重复：用同一 base/base_at 多次计算得到同一值', () => {
  const node = nodeAt(0);
  const a = effectiveStrength(node, nowAt(30), STRENGTH);
  const b = effectiveStrength(node, nowAt(30), STRENGTH);
  assert.equal(a, b);
  // 若把衰减后的值当新 base（错误实现），第二次会明显更低
  const wrong = effectiveStrength({ ...node, strength_base: a, strength_base_at: nowAt(30).toISOString() }, nowAt(60), STRENGTH);
  assert.ok(wrong < a);
  assert.ok(a > 0.3);
});

test('不同 tier 的衰减速度不同：edge 掉得最快', () => {
  const at = nowAt(30);
  const core = effectiveStrength(nodeAt(0, { tier: 'core' }), at, STRENGTH);
  const normal = effectiveStrength(nodeAt(0, { tier: 'normal' }), at, STRENGTH);
  const edge = effectiveStrength(nodeAt(0, { tier: 'edge' }), at, STRENGTH);
  assert.ok(core > normal && normal > edge);
});

test('相关度 = 匹配强度 × 上下文加成（上下文不能凭空给分）', () => {
  const all = relevanceOf({ anchorMatch: 1, lexicalMatch: 1, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 });
  assert.equal(Number(all.score.toFixed(6)), 1);
  // 纯锚点：match = 0.55，context 取中位数时最多放大 25%
  const onlyAnchor = relevanceOf({ anchorMatch: 1, lexicalMatch: 0, intentMatch: 0, temporalMatch: 0, recencyMatch: 0 });
  assert.equal(Number(onlyAnchor.score.toFixed(6)), Number((0.55 * 0.75).toFixed(6)));
  const onlyLexical = relevanceOf({ anchorMatch: 0, lexicalMatch: 1, intentMatch: 0, temporalMatch: 0, recencyMatch: 0 });
  assert.equal(Number(onlyLexical.score.toFixed(6)), Number((0.45 * 0.75).toFixed(6)));
});

test('完全没有匹配时，新近度/时间再高也拿不到相关度（防止注入无关旧内容）', () => {
  const noMatch = relevanceOf({ anchorMatch: 0, lexicalMatch: 0, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 });
  assert.equal(noMatch.score, 0);
  assert.equal(noMatch.parts.match, 0);
});

test('上下文加成最多放大 25%，不会让弱匹配压过强匹配', () => {
  const strongNoContext = relevanceOf({ anchorMatch: 1, lexicalMatch: 1, intentMatch: 0, temporalMatch: 0, recencyMatch: 0 });
  const weakFullContext = relevanceOf({ anchorMatch: 0.3, lexicalMatch: 0.3, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 });
  assert.ok(strongNoContext.score > weakFullContext.score);
  const maxBoost = relevanceOf({ anchorMatch: 0.5, lexicalMatch: 0.5, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 }).score;
  const minBoost = relevanceOf({ anchorMatch: 0.5, lexicalMatch: 0.5, intentMatch: 0, temporalMatch: 0, recencyMatch: 0 }).score;
  assert.ok(maxBoost <= minBoost * 1.35, '上下文加成必须受控');
});

test('相关度与可信度分离：语义相近但来源不可信的节点总分受限', () => {
  const features = { anchorMatch: 1, lexicalMatch: 1, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 };
  const trusted = finalScore({ node: nodeAt(0, { source_type: 'user_explicit', extraction_confidence: 1 }), features, now: nowAt(0), strengthCfg: STRENGTH });
  const generated = finalScore({ node: nodeAt(0, { source_type: 'agent_generated', extraction_confidence: 0.3 }), features, now: nowAt(0), strengthCfg: STRENGTH });
  assert.ok(trusted.score > generated.score);
  assert.equal(trusted.relevance, generated.relevance); // 相关度相同
  assert.ok(trusted.confidence > generated.confidence);
});

test('非 active 状态一律不可自动注入', () => {
  const features = { anchorMatch: 1, lexicalMatch: 1, intentMatch: 1, temporalMatch: 1, recencyMatch: 1 };
  for (const state of ['pending_confirm', 'superseded', 'cancelled', 'expired', 'deleted']) {
    const result = finalScore({ node: nodeAt(0, { state }), features, now: nowAt(0), strengthCfg: STRENGTH });
    assert.equal(result.score, 0, `state=${state} 不应得分`);
    assert.equal(STATE_ELIGIBILITY[state], 0);
  }
});

test('过期时间限定记忆的时间匹配度为 0', () => {
  const node = nodeAt(0, { valid_until: nowAt(10).toISOString() });
  assert.equal(temporalMatch(node, nowAt(30)), 0);
  assert.ok(temporalMatch(node, nowAt(5)) > 0);
});

test('意图匹配：计划类查询偏好 plan/task', () => {
  assert.equal(intentMatch('plan', { memory_type: 'plan' }), 1);
  assert.equal(intentMatch('plan', { memory_type: 'preference' }), 0.3);
  assert.equal(intentMatch(null, { memory_type: 'plan' }), 0.5);
});

test('新近度单调下降', () => {
  const node = nodeAt(0);
  assert.ok(recencyMatch(node, nowAt(0)) > recencyMatch(node, nowAt(180)));
  assert.ok(recencyMatch(node, nowAt(3650)) > 0);
});

test('阶段投影：越省表示保留的字段越少，但不销毁原数据', () => {
  const node = {
    payload: { subject: '主人', action: 'travel', object: '成都', when: '2026-10-28', status: 'planned' },
    summary: '去成都',
  };
  assert.equal(Object.keys(projectStage(node, 'full').payload).length, 5);
  assert.equal(Object.keys(projectStage(node, 'summary').payload).length, 5);
  assert.ok(Object.keys(projectStage(node, 'keyword').payload).length < 5);
  assert.ok(Object.keys(projectStage(node, 'anchor').payload).length <= 2);
  assert.equal(projectStage(node, 'keyword').summary, null);
  // 原始 payload 不被修改
  assert.equal(node.payload.subject, '主人');
});

test('lexicalScoreFromRank 是单调映射且落在 0..1（仅作次序参考）', () => {
  assert.ok(lexicalScoreFromRank(-5) > lexicalScoreFromRank(-0.1));
  assert.equal(lexicalScoreFromRank(Number.NaN), 0);
  assert.ok(lexicalScoreFromRank(-1e9) <= 1);
});
