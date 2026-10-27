#!/usr/bin/env node
/**
 * 性能与 token 基线基准（计划书 §14.2）。
 *
 *   node scripts/bench.mjs                 # 默认 10000 节点 / 200 次查询
 *   node scripts/bench.mjs --nodes 2000 --queries 100
 *
 * 只测量**本地检索与排序**耗时，不含模型调用或远程嵌入调用（本版本没有向量检索）。
 * token 基线有两种口径，都会打印：
 *   B1「命中候选的原始正文」：最不利对照 —— 记忆库很小时，结构化表示本就可能比一句原文贵
 *   B2「会话窗口」：把最近 N 条聊天消息整段塞进上下文，这是长期记忆真正要替代的东西
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/service.js';
import { estimateTokens } from '../src/tokenize.js';

const args = process.argv.slice(2);
const num = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};

const NODE_COUNT = num('--nodes', 10000);
const QUERY_COUNT = num('--queries', 200);
const WINDOW_MESSAGES = num('--window', 50);

const SEMANTIC = [
  ['成都出差', '我下周三要去成都出差，计划十月二十八号出发'],
  ['成都天气', '我讨厌成都的潮湿天气'],
  ['香菜', '我讨厌香菜，闻到就皱眉头'],
  ['美式咖啡', '我喜欢喝美式咖啡，不加糖'],
  ['豆豆', '我养了一只叫豆豆的猫，是橘猫'],
  ['换工作', '我打算年底换工作，想去上海'],
  ['面试', '我下个月有一次面试，准备得有点紧张'],
  ['健身', '我最近在健身，一周去三次健身房'],
  ['膝盖', '我膝盖有旧伤，跑步不能太久'],
  ['马拉松', '我打算报名下个月的半程马拉松'],
  ['日本樱花', '我明年春天想去日本看樱花'],
  ['护照', '我护照还有两年过期，得提前换'],
  ['Rust', '我在学 Rust，主要想写点命令行工具'],
  ['英语课', '我每周六上午有英语课'],
  ['战双', '我在玩战双帕弥什，最喜欢露西亚这个角色'],
  ['抽卡', '我讨厌抽卡抽歪，上次抽了一百二十发才出'],
  ['我妈', '我妈住在老家，身体还算好'],
  ['我妹妹', '我妹妹今年上大学，学的是设计'],
  ['过年回家', '我打算过年回家待两周'],
  ['陈奕迅', '我喜欢听陈奕迅，尤其是早期的专辑'],
  ['熬夜', '我经常熬夜到两点，早上起不来'],
  ['睡前牛奶', '我睡前习惯喝一杯热牛奶'],
  ['攒钱', '我在攒钱买一台新笔记本，目标是两万'],
  ['订阅制', '我讨厌订阅制会员，能买断就买断'],
];

const FILLER_TEMPLATES = [
  '今天{thing}真的{adj}，我一直{verb}到晚上',
  '关于{topic}这件事，我{adj2}觉得还行吧',
  '上次聊到{topic}的时候我还在{place}',
  '群里有人说{topic}，我觉得{adj}',
  '{place}的{topic}最近很火，你听说过吗',
  '我朋友昨天去了{place}，说{topic}挺有意思',
  '这个{topic}我研究了半天，还是没搞懂',
  '刚看到{place}的天气，{adj}得不行',
];

const THINGS = ['火锅', '地铁', '天气', '房租', '外卖', '快递', '考试', '加班', '咖啡', '电影', '球赛', '菜价', '手机', '电脑', '椅子', '台灯'];
const TOPICS = ['这个版本', '那个角色', '新出的番', '老游戏', '那本书', '这个梗', '新政策', '那家店', '这条路线', '那个梗'];
const PLACES = ['杭州', '上海', '北京', '广州', '深圳', '南京', '武汉', '西安', '苏州', '厦门'];
const ADJ = ['离谱', '有意思', '麻烦', '舒服', '复杂', '搞笑', '安静', '热闹'];
const ADJ2 = ['其实', '真的', '大概', '一直'];
const VERB = ['忙', '刷', '看', '聊', '折腾'];

let seed = 20261019;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (list) => list[Math.floor(rand() * list.length) % list.length];

function filler(index) {
  const template = FILLER_TEMPLATES[index % FILLER_TEMPLATES.length];
  return template
    .replace('{thing}', pick(THINGS))
    .replace('{topic}', pick(TOPICS))
    .replace('{place}', pick(PLACES))
    .replace('{adj}', pick(ADJ))
    .replace('{adj2}', pick(ADJ2))
    .replace('{verb}', pick(VERB));
}

const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-memory-bench-')), 'bench.sqlite');
const service = createMemoryService({ config: { databasePath, defaultScope: 'bench:main' } });
const now = new Date('2026-10-19T10:00:00.000Z');

console.log(`准备数据：${NODE_COUNT} 节点 ...`);
const writeStart = process.hrtime.bigint();

// ── 数据构成 ──
// 25% 走真实写入管线（service.write：抽取 + 锚点 + FTS + 审计），
// 75% 用仓储层批量灌入噪声（聊天记录式内容不会过抽取规则，但检索面对它必须有代表性）。
// 批量灌入只用于基准制造语料，不是产品功能。
const semanticTarget = Math.floor(NODE_COUNT / 4);
let written = 0;
for (let index = 0; written < semanticTarget; index += 1) {
  const [topic, text] = SEMANTIC[index % SEMANTIC.length];
  const variant = index < SEMANTIC.length ? text : `${text}（第${Math.floor(index / SEMANTIC.length) + 1}次提到${topic}）`;
  const result = service.write(variant, { now });
  written += result.written?.length ?? 0;
  if (result.written?.length === 0) index += 1; // 去重时不空转
}

const { insertNode, upsertAnchor, linkAnchor, ftsUpsert } = await import('../src/repository.js');
const { transaction } = await import('../src/db.js');
const { newNodeId } = await import('../src/models.js');
const { extractAnchorTokens } = await import('../src/extractor.js');

const noiseTarget = Math.max(0, NODE_COUNT - service.list({}).total);
const BATCH = 250;
for (let batchStart = 0; batchStart < noiseTarget; batchStart += BATCH) {
  const batchEnd = Math.min(noiseTarget, batchStart + BATCH);
  transaction(service.handle, () => {
    for (let index = batchStart; index < batchEnd; index += 1) {
      const text = filler(index);
      const nodeId = newNodeId();
      const iso = now.toISOString();
      insertNode(service.handle, {
        node_id: nodeId,
        owner_scope: 'bench:main',
        payload_json: JSON.stringify({ subject: '主人', action: 'event', object: pick(TOPICS), status: 'unknown', source_type: 'user_explicit' }),
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
        const anchorId = upsertAnchor(service.handle, 'bench:main', {
          normalizedToken: token.toLowerCase(),
          displayToken: token,
          type: 'topic',
          now: iso,
        });
        linkAnchor(service.handle, 'bench:main', nodeId, anchorId, { weight: 0.5, role: 'topic' });
      }
      ftsUpsert(service.handle, nodeId, text);
    }
  });
}

const writeMs = Number(process.hrtime.bigint() - writeStart) / 1e6;
const total = service.list({}).total;
console.log(`写入完成：${total} 条，用时 ${writeMs.toFixed(0)}ms（${(writeMs / Math.max(1, total)).toFixed(2)}ms/条）`);
if (total < NODE_COUNT * 0.9) {
  console.error(`警告：实际节点数 ${total} 明显少于目标 ${NODE_COUNT}，本次延迟数据不代表 ${NODE_COUNT} 规模`);
}

// ── 召回延迟 ──
const latencies = [];
const usedTokensList = [];
const baselineB1 = [];
const baselineB2 = [];
const relevantQueries = [];
for (let index = 0; index < QUERY_COUNT; index += 1) {
  const [topic] = SEMANTIC[index % SEMANTIC.length];
  const query = index % 5 === 0 ? `${topic} 你还记得吗` : topic;
  relevantQueries.push(query);
  const start = process.hrtime.bigint();
  const result = service.recall(query, { now });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  latencies.push(ms);
  usedTokensList.push(result.metrics.usedTokens);

  // B1：FTS 命中的候选原始正文（上限取 topK 条，模拟"把相关历史塞进去"）
  const hits = result.memories;
  baselineB1.push(hits.reduce((acc, memory) => acc + estimateTokens(memory.summary ?? ''), 0));
  // B2：最近 N 条消息整段（这里用固定消息平均长度 × N 估算，测量口径写进报告）
  baselineB2.push(estimateTokens('我下周三要去成都出差，计划十月二十八号出发') * WINDOW_MESSAGES);
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

const sum = (values) => values.reduce((acc, value) => acc + value, 0);
const avg = (values) => (values.length === 0 ? null : Number((sum(values) / values.length).toFixed(2)));

// 清理与索引一致性
const health = service.health();

const report = {
  generated_at: new Date().toISOString(),
  nodes: total,
  queries: QUERY_COUNT,
  write_ms: Number(writeMs.toFixed(0)),
  write_ms_per_node: Number((writeMs / Math.max(1, total)).toFixed(3)),
  recall_latency_ms: {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Number(Math.max(...latencies).toFixed(2)),
    avg: avg(latencies),
  },
  injected_tokens: {
    avg: avg(usedTokensList),
    max: Math.max(...usedTokensList),
  },
  token_baseline_b1_matched_raw_text: {
    definition: '把 FTS 命中的相关记忆原文全部塞进上下文（最不利对照）',
    avg: avg(baselineB1),
    reduction: baselineB1.some((value) => value > 0)
      ? Number((1 - sum(usedTokensList) / Math.max(1, sum(baselineB1))).toFixed(4))
      : null,
  },
  token_baseline_b2_conversation_window: {
    definition: `把最近 ${WINDOW_MESSAGES} 条聊天消息整段塞进上下文（长期记忆真正替代的东西）`,
    avg: avg(baselineB2),
    reduction: Number((1 - sum(usedTokensList) / Math.max(1, sum(baselineB2))).toFixed(4)),
  },
  health: {
    ok: health.ok,
    fts5: health.fts5,
    counts: health.counts,
    warnings: health.warnings,
  },
  integrity: service.integrity(),
};

console.log('\n=== 基准结果 ===');
console.log(JSON.stringify(report, null, 2));

service.close();
try {
  fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
} catch {
  /* ignore */
}
