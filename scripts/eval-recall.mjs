#!/usr/bin/env node
/**
 * 召回质量评测（计划书 §14.1 / §14.2）。
 *
 *   node scripts/eval-recall.mjs            # 跑全量标注用例
 *   node scripts/eval-recall.mjs --json     # 只输出 JSON 结果
 *   node scripts/eval-recall.mjs --verbose  # 打印每个失败用例
 *
 * 指标口径（写进报告时会注明）：
 *   - recall@k：标注"应召回"的节点中，实际进入注入载荷的比例（宏平均）
 *   - irrelevant_injection_rate：注入载荷里不属于 expect 的比例
 *     （分母 = 所有注入条目；只在判定期望非空的用例上统计）
 *   - empty_recall_rate：应空召回的用例里确实返回空的比率
 *   - 每条用例使用独立 owner_scope，顺带验证隔离
 *   - token 对比基线：把 FTS 命中的**原始正文**全部塞进上下文，作为"塞入相关原始历史"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/service.js';
import { buildCases } from '../tests/fixtures/annotated-cases.mjs';
import { estimateTokens } from '../src/tokenize.js';
import * as repo from '../src/repository.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-memory-eval-')), 'eval.sqlite');
const numberArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const minRelevance = numberArg('--min-relevance', null);
const maxPerTopic = numberArg('--max-per-topic', null);
const relativeFloor = numberArg('--relative-floor', null);
const service = createMemoryService({
  config: {
    databasePath,
    defaultScope: 'eval:default',
    ...(minRelevance === null && maxPerTopic === null && relativeFloor === null
      ? {}
      : { recall: { ...(minRelevance === null ? {} : { minRelevance }), ...(maxPerTopic === null ? {} : { maxPerTopic }), ...(relativeFloor === null ? {} : { relativeFloor }) } }),
  },
});

const now = new Date('2026-10-19T10:00:00.000Z');
const cases = buildCases();
const failures = [];
const rows = [];

let expectTotal = 0;
let expectHit = 0;
let injectedTotal = 0;
let injectedRelevant = 0;
let expectedEmptyCases = 0;
let emptyCorrect = 0;
let baselineTokens = 0;
let injectedTokens = 0;

for (const testCase of cases) {
  const scope = testCase.scope;
  const refs = new Map(); // op index -> node_id
  const texts = new Map(); // node_id -> canonical text（用于 token 基线）

  // 重放该用例的操作
  for (const [index, op] of testCase.ops.entries()) {
    if (op.op === 'write') {
      const result = service.write(op.text, { now, scope });
      const written = result.written?.[0];
      if (written?.node_id) {
        refs.set(index, written.node_id);
        texts.set(written.node_id, op.text);
      }
    } else if (op.op === 'correct') {
      const targetId = refs.get(op.target);
      const result = service.correct({ nodeId: targetId, text: op.text }, { now, scope });
      if (result.ok) {
        refs.set(index, result.newNodeId);
        texts.set(result.newNodeId, op.text);
        texts.delete(targetId);
      }
    } else if (op.op === 'forget') {
      const targetId = refs.get(op.target);
      service.forget({ nodeId: targetId }, { now, scope });
      texts.delete(targetId);
    }
  }

  const queryScope = testCase.queryScope ?? scope;
  const recall = service.recall(testCase.query, { now, scope: queryScope });
  const returnedIds = recall.memories.map((memory) => memory.node_id);
  const expectedIds = new Set((testCase.expect ?? []).map((index) => refs.get(index)).filter(Boolean));
  const forbiddenIds = new Set((testCase.forbid ?? []).map((index) => refs.get(index)).filter(Boolean));

  // ---- recall@k ----
  for (const id of expectedIds) {
    expectTotal += 1;
    if (returnedIds.includes(id)) expectHit += 1;
  }

  // ---- 无关注入率 ----
  const judging = expectedIds.size > 0;
  if (judging) {
    for (const id of returnedIds) {
      injectedTotal += 1;
      if (expectedIds.has(id)) injectedRelevant += 1;
    }
  }

  // ---- 空召回 ----
  if (testCase.expectEmpty) {
    expectedEmptyCases += 1;
    if (returnedIds.length === 0) emptyCorrect += 1;
  }

  // ---- token 基线 ----
  let candidateRawTokens = 0;
  try {
    const hits = repo.searchFts(service.handle, queryScope, testCase.query, 200);
    for (const hit of hits) {
      const text = texts.get(hit.node_id);
      if (text) candidateRawTokens += estimateTokens(text);
    }
  } catch {
    candidateRawTokens = 0;
  }
  baselineTokens += candidateRawTokens;
  injectedTokens += recall.metrics.usedTokens;

  // ---- 违规检查 ----
  const leakedForbidden = returnedIds.filter((id) => forbiddenIds.has(id));
  const emptyViolation = testCase.expectEmpty && returnedIds.length > 0;
  const forbiddenTextViolation = testCase.forbidText
    ? recall.memories.some((memory) => JSON.stringify(memory).includes(testCase.forbidText))
    : false;
  if (leakedForbidden.length > 0 || emptyViolation || forbiddenTextViolation) {
    failures.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      leaked_forbidden: leakedForbidden,
      empty_violation: emptyViolation,
      forbidden_text_violation: forbiddenTextViolation,
      returned: returnedIds,
    });
  }

  rows.push({
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    expected: [...expectedIds],
    returned: returnedIds,
    used_tokens: recall.metrics.usedTokens,
    baseline_tokens: candidateRawTokens,
  });
}

const relevantInjectionRate = injectedTotal === 0 ? null : Number((injectedRelevant / injectedTotal).toFixed(4));
const irrelevantInjectionRate = injectedTotal === 0 ? null : Number((1 - injectedRelevant / injectedTotal).toFixed(4));
const tokenReduction = baselineTokens === 0 ? null : Number((1 - injectedTokens / baselineTokens).toFixed(4));

const summary = {
  generated_at: new Date().toISOString(),
  database: databasePath,
  case_count: cases.length,
  recall_at_k: expectTotal === 0 ? null : Number((expectHit / expectTotal).toFixed(4)),
  recall_samples: expectTotal,
  irrelevant_injection_rate: irrelevantInjectionRate,
  relevant_injection_rate: relevantInjectionRate,
  injection_samples: injectedTotal,
  empty_recall_accuracy: expectedEmptyCases === 0 ? null : Number((emptyCorrect / expectedEmptyCases).toFixed(4)),
  empty_samples: expectedEmptyCases,
  token_baseline: baselineTokens,
  token_injected: injectedTokens,
  token_reduction: tokenReduction,
  violation_count: failures.length,
  violations_by_category: failures.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {}),
};

if (flag('--json')) {
  console.log(JSON.stringify({ summary, failures }, null, 2));
} else {
  console.log('=== 召回质量评测 ===');
  console.log(JSON.stringify(summary, null, 2));
  if (flag('--verbose')) {
    console.log('\n=== 违规明细 ===');
    for (const failure of failures) console.log(JSON.stringify(failure));
  }
}

service.close();
if (!flag('--keep')) {
  try {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放时留着临时目录也无害 */
  }
}

// 有违规用例时以非零退出码提醒
if (failures.length > 0) process.exitCode = 1;
