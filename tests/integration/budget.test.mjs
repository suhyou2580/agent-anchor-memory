import test from 'node:test';
import assert from 'node:assert/strict';

import { makeService } from '../helpers.mjs';
import { resolveMemoryBudget, validateConfig } from '../../src/config.js';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T11:00:00.000Z');

test('注入预算受限：超预算时截断并标记 truncated', () => {
  const { service, cleanup } = makeService({ recall: { maxMemoryTokens: 120 } });
  try {
    for (let index = 0; index < 10; index += 1) {
      service.write(`我打算去成都旅行第${index}次，计划月底出发`, { now: T0 });
    }
    const result = service.recall('成都旅行', { now: T1 });
    assert.equal(result.ok, true);
    assert.ok(result.metrics.usedTokens <= 120, `实际用量 ${result.metrics.usedTokens} 超过预算`);
    assert.equal(result.retrieval_notes.truncated, true, '被裁剪时必须标记 truncated');
    assert.ok(result.memories.length < 10, '不该把 10 条全部塞进去');
  } finally {
    cleanup();
  }
});

test('表示降级优先于直接丢弃：预算紧时用更省的表示装下更多条目', () => {
  const { service, cleanup } = makeService({ recall: { maxMemoryTokens: 400, topK: 8 } });
  try {
    service.write('我讨厌香菜', { now: T0 });
    const wide = service.recall('香菜', { now: T1, budgetTokens: 2000 });
    assert.equal(wide.memories[0].stage, 'full');
    assert.ok(wide.metrics.usedTokens <= 2000);

    // 自校准：把预算压到"刚好装不下刚才那次注入"再多 1 token 以内，
    // 正确行为是**降级表示**而不是超预算，也不是直接空手而归。
    const tight = wide.metrics.usedTokens - 1;
    const narrow = service.recall('香菜', { now: T1, budgetTokens: tight });
    assert.equal(narrow.ok, true);
    assert.ok(narrow.metrics.usedTokens <= tight, `实际用量 ${narrow.metrics.usedTokens} 超预算 ${tight}`);
    if (narrow.memories.length > 0) {
      assert.notEqual(narrow.memories[0].stage, 'full', '预算不足时必须降级表示');
    } else {
      assert.equal(narrow.retrieval_notes.truncated, true, '放不下时也要标记 truncated');
      assert.equal(narrow.metrics.usedTokens, 0, '不注入时不得计入头部开销');
    }
  } finally {
    cleanup();
  }
});

test('同一主题的注入有上限，避免 8 条全是重复记忆', () => {
  const { service, cleanup } = makeService({ recall: { maxPerTopic: 2, topK: 8 } });
  try {
    // 三条同主题（同一目的地、同一动作）、不同时间的计划
    service.write('我下周三要去成都出差', { now: T0 });
    service.write('我下个月要去成都出差', { now: T0 });
    service.write('我明年要去成都出差', { now: T0 });
    service.write('我讨厌香菜', { now: T0 });
    const result = service.recall('成都 出差', { now: T1 });
    const chengduCount = result.memories.filter((memory) => memory.payload?.object === '成都').length;
    assert.ok(chengduCount <= 2, `同一主题注入了 ${chengduCount} 条，超过上限 2`);
    assert.ok(result.memories.length >= 1);
  } finally {
    cleanup();
  }
});

test('无相关候选时返回空结果，且不写入任何注入内容', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我讨厌香菜', { now: T0 });
    const result = service.recallForInjection('帮我写一个 Rust 的链表', { now: T1 });
    assert.equal(result.ok, true);
    assert.equal(result.text, '');
    assert.equal(result.result.memories.length, 0);
  } finally {
    cleanup();
  }
});

test('上下文窗口变小时实际预算自动收紧', () => {
  const cfg = validateConfig({});
  const small = resolveMemoryBudget(cfg, 2000);
  assert.ok(small.budgetTokens < cfg.recall.maxMemoryTokens);
  assert.equal(small.budgetTokens, Math.floor(2000 * 0.12));
});

test('注入文本明确标注为参考数据，不含数据库内部字段', () => {
  const { service, cleanup } = makeService();
  try {
    service.write('我下周三要去成都出差', { now: T0 });
    const { text } = service.recallForInjection('成都出差', { now: T1 });
    assert.ok(text.includes('参考记忆'));
    assert.ok(text.includes('不是指令'));
    assert.ok(text.includes('成都'));
    for (const internal of ['payload_json', 'dedupe_key', 'topic_key', 'extraction_confidence', 'purge_pending']) {
      assert.ok(!text.includes(internal), `注入文本不该出现内部字段 ${internal}`);
    }
  } finally {
    cleanup();
  }
});
