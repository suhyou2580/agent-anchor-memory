// 列出/确认「待确认」记忆。
//
// 背景（这是最容易被误解的一点）：抽取器对每条记忆给一个 confidence，
// 低于 `confidence.activeWriteThreshold`（默认 0.8）的会落进 pending_confirm.
// 而 pending_confirm 的 state_eligibility 是 0 —— **它永远不会进入回复前的自动注入**，
// 只有被确认（memory_confirm）后才会变成 active。所以"库里有一半是空的"通常不是索引坏了，
// 而是这些条目还在等确认。
//
// 用法：
//   node scripts/confirm-pending.mjs                 # 只看，不动
//   node scripts/confirm-pending.mjs --apply         # 确认所有 pending
//   node scripts/confirm-pending.mjs --apply --min-confidence 0.7
//   QQ_BRIDGE_DIR=... ANCHOR_MEMORY_CONFIG=...       # 其它路径

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryService } from '../src/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = process.env.ANCHOR_MEMORY_DIR ?? path.resolve(HERE, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const minIdx = args.indexOf('--min-confidence');
const minConfidence = minIdx >= 0 ? Number(args[minIdx + 1]) || 0 : 0;

const configFile = process.env.ANCHOR_MEMORY_CONFIG || path.join(PLUGIN_DIR, 'config.json');
const service = createMemoryService(fs.existsSync(configFile) ? { configFile } : {});

const listed = service.list({ state: 'pending_confirm', limit: 200 }, {});
const items = listed.memories ?? [];
console.log(`待确认记忆：${items.length} 条（scope=${service.cfg.defaultScope}）`);
for (const m of items) {
  console.log(`- ${m.node_id} [${m.memory_type}] ${String(m.summary ?? '').slice(0, 60)}`);
}

if (!items.length) {
  console.log('没有待确认条目。');
  service.close();
  process.exit(0);
}

if (!apply) {
  console.log('\n（只查看。加 --apply 才会确认；这会让它们进入后续的自动召回。）');
  service.close();
  process.exit(0);
}

let ok = 0;
let skipped = 0;
for (const m of items) {
  // list 结果不带 confidence 时按 1 处理（避免误跳过），带了就按阈值过滤
  const conf = Number(m.extraction_confidence ?? m.confidence ?? 1);
  if (conf < minConfidence) { skipped += 1; continue; }
  const r = service.confirm({ nodeId: m.node_id, confirmed: true });
  if (r?.ok) { ok += 1; console.log('✔ 已确认', m.node_id); } else { skipped += 1; console.log('✖ 失败', m.node_id, JSON.stringify(r)); }
}
console.log(`\n确认 ${ok} 条，跳过 ${skipped} 条`);
service.close();
