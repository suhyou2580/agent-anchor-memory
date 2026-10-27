#!/usr/bin/env node
/**
 * 端到端演示：写入 → 召回 → 纠正 → 忘记，全部在临时库上跑，不碰生产数据。
 *
 *   node scripts/demo.mjs
 *   node scripts/demo.mjs --keep   # 保留临时数据库以便自己翻
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/service.js';

const keep = process.argv.includes('--keep');
const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-memory-demo-')), 'demo.sqlite');
const service = createMemoryService({ config: { databasePath, defaultScope: 'demo:owner' } });

const now = new Date('2026-10-19T10:00:00.000Z');
const later = new Date('2026-10-19T11:00:00.000Z');
const show = (title, value) => console.log(`\n── ${title} ──\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

try {
  show('1. 写入三条记忆', [
    service.write('我下周三要去成都出差，计划十月二十八号出发', { now }),
    service.write('记住：我讨厌香菜，闻到就皱眉头', { now }),
    service.write('我养了一只叫豆豆的猫，是橘猫', { now }),
  ].map((result) => result.written.map((item) => ({ id: item.node_id, type: item.memory_type, state: item.state, anchors: item.anchors }))));

  const recall = service.recallForInjection('我下周去成都的事你还记得吗', { now: later });
  show('2. 回复前自动注入的内容（模型真正看到的片段）', recall.text);

  const list = service.list({ limit: 10 }, {});
  show('3. 当前记忆列表', list.memories.map((memory) => ({ id: memory.node_id, type: memory.memory_type, state: memory.state, summary: memory.summary })));

  const target = list.memories.find((memory) => memory.summary?.includes('成都'));
  const corrected = service.correct({ nodeId: target.node_id, text: '我改成下周去重庆出差' }, { now: later });
  show('4. 纠正（旧值退出普通召回）', corrected);
  show('   纠正后的召回结果', service.recall('成都出差', { now: later }).memories.map((memory) => ({ id: memory.node_id, object: memory.payload.object })));
  show('   历史查询（能看到旧版本）', service.recall('成都出差', { now: later, includeHistorical: true }).memories.map((memory) => ({ id: memory.node_id, state: memory.state })));

  const cat = list.memories.find((memory) => memory.summary?.includes('豆豆'));
  const forgotten = service.forget({ nodeId: cat.node_id }, { now: later });
  show('5. 忘记（清空正文/锚点/边/索引）', forgotten);
  show('   忘记后立刻查不到', service.recall('豆豆', { now: later }).memories.length);

  show('6. 健康检查', service.health());
  console.log(`\n临时库：${databasePath}`);
} finally {
  service.close();
  if (!keep) {
    try {
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
