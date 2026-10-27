import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/service.js';
import * as repo from '../../src/repository.js';
import { transaction } from '../../src/db.js';
import { newNodeId } from '../../src/models.js';
import { extractAnchorTokens } from '../../src/extractor.js';

const NODE_COUNT = Number(process.env.ANCHOR_BENCH_NODES ?? 2000);
const QUERY_COUNT = Number(process.env.ANCHOR_BENCH_QUERIES ?? 120);

const NOISE = [
  '今天群里聊到火锅，我大概觉得还行，顺便刷了一下手机',
  '刚看到杭州的天气，离谱得不行，一直忙到晚上',
  '这个版本我研究了半天，还是没搞懂那个角色怎么玩',
  '外卖到了，菜价又涨了，我折腾了一下午电脑',
  '朋友昨天去了上海，说那条路线挺有意思',
];

function seed(service, now) {
  const iso = now.toISOString();
  for (let start = 0; start < NODE_COUNT; start += 250) {
    transaction(service.handle, () => {
      for (let index = start; index < Math.min(NODE_COUNT, start + 250); index += 1) {
        const text = `${NOISE[index % NOISE.length]}（第${index}条）`;
        const nodeId = newNodeId();
        repo.insertNode(service.handle, {
          node_id: nodeId,
          owner_scope: 'perf:main',
          payload_json: JSON.stringify({ subject: '主人', action: 'event', object: `话题${index}`, status: 'unknown', source_type: 'user_explicit' }),
          canonical_text: text,
          summary: text.slice(0, 60),
          memory_type: 'event',
          tier: 'edge',
          stage: 'full',
          state: 'active',
          extraction_confidence: 0.7,
          source_confidence: 0.9,
          source_type: 'user_explicit',
          strength_base: 1,
          strength_base_at: iso,
          created_at: iso,
          updated_at: iso,
        });
        for (const token of extractAnchorTokens(text, { limit: 3 })) {
          const anchorId = repo.upsertAnchor(service.handle, 'perf:main', {
            normalizedToken: token.toLowerCase(),
            displayToken: token,
            type: 'topic',
            now: iso,
          });
          repo.linkAnchor(service.handle, 'perf:main', nodeId, anchorId, { weight: 0.5, role: 'topic' });
        }
        repo.ftsUpsert(service.handle, nodeId, text);
      }
    });
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

test(`${NODE_COUNT} 节点规模下，检索与排序 P95 < 100ms（不含模型调用）`, () => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-memory-perf-')), 'perf.sqlite');
  const service = createMemoryService({ config: { databasePath, defaultScope: 'perf:main' } });
  const now = new Date('2026-10-19T10:00:00.000Z');
  try {
    // 语义记忆走真实写入管线
    const semantic = ['我下周三要去成都出差', '我讨厌香菜', '我喜欢喝美式咖啡', '我养了一只叫豆豆的猫', '我打算年底换工作'];
    for (const text of semantic) service.write(text, { now });

    seed(service, now);
    assert.ok(service.list({}).total >= NODE_COUNT, `语料不足：${service.list({}).total}`);

    const latencies = [];
    const queries = ['成都出差', '香菜', '美式咖啡', '豆豆', '换工作', '成都 你还记得吗', '完全不相干的问题xyz'];
    for (let index = 0; index < QUERY_COUNT; index += 1) {
      const query = queries[index % queries.length];
      const start = process.hrtime.bigint();
      const result = service.recall(query, { now });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      assert.equal(result.ok, true);
    }

    const p95 = percentile(latencies, 95);
    const p50 = percentile(latencies, 50);
    // 只在耗时超过目标时才打印，避免污染常规测试输出
    if (p95 >= 100) {
      console.log(`[perf] nodes=${NODE_COUNT} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    }
    assert.ok(p95 < 100, `P95 ${p95.toFixed(2)}ms 超过 100ms 目标（p50=${p50.toFixed(2)}ms）`);
    assert.ok(p50 < 50, `P50 ${p50.toFixed(2)}ms 过高`);
  } finally {
    service.close();
    try {
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('注入写入不会随时间退化（批量写入吞吐下限）', () => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-memory-perf2-')), 'perf2.sqlite');
  const service = createMemoryService({ config: { databasePath, defaultScope: 'perf:write' } });
  const now = new Date('2026-10-19T10:00:00.000Z');
  try {
    const count = 300;
    const start = process.hrtime.bigint();
    for (let index = 0; index < count; index += 1) {
      service.write(`我讨厌第${index}种噪音`, { now });
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const perNode = ms / count;
    assert.ok(perNode < 50, `单条写入 ${perNode.toFixed(2)}ms 过慢`);
  } finally {
    service.close();
    try {
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
