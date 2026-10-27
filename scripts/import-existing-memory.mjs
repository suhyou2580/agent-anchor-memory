// 把已有记忆（口味 / 日记 / 世界观 / 归档里的关键句）导入 anchor-memory。
//
// 为什么用"句子"而不是直接插行：插件的抽取器是规则式的（偏好/事实/计划/承诺/任务），
// 走它自己的写入通道才能保证 FTS 索引、锚点、去重键都正确生成；直接插 SQL 会漏掉
// 触发器和锚点关系，检索就会失效。所以这里把已有记忆改写成抽取器认得的句式。
//
// 用法：
//   node scripts/import-existing-memory.mjs
//   QQ_BRIDGE_DIR=D:/qq-bridge node scripts/import-existing-memory.mjs
//   （可选）ANCHOR_MEMORY_CONFIG=<插件目录>/config.json 指定配置
//
// 幂等：同样的句子重复导入会被去重键拦掉，不会长出重复节点。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryService } from '../src/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = process.env.ANCHOR_MEMORY_DIR ?? path.resolve(HERE, '..');
const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR ?? 'D:\\qq-bridge';
const STATE_DIR = path.join(BRIDGE_DIR, 'state');

const configFile = process.env.ANCHOR_MEMORY_CONFIG || path.join(PLUGIN_DIR, 'config.json');
const service = createMemoryService(fs.existsSync(configFile) ? { configFile } : {});
const scope = service.cfg.defaultScope;

const lines = [];

// 1) 她自己记下的喜好 → 偏好句
try {
  const tastes = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'taste.json'), 'utf8'));
  for (const t of tastes) {
    if (!t?.title) continue;
    const why = t.why ? `，因为${t.why}` : '';
    lines.push(`我喜欢${t.app || ''}的${t.title}${why}`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn('读取口味失败:', error.message);
}

// 2) 日记 → 事实句（挑每篇最像"自己的想法"的几句）
try {
  const dir = path.join(BRIDGE_DIR, 'diary');
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const body = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>')).join(' ');
    const sentences = body.split(/(?<=[。！？])/).map((s) => s.trim()).filter((s) => s.length > 8);
    for (const s of sentences.slice(0, 3)) {
      lines.push(`我是这样想的：${s.replace(/^[（(].*?[)）]/, '').slice(0, 120)}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn('读取日记失败:', error.message);
}

// 3) 世界观 → 承诺句（她自己的看法，尽量保留原话）
try {
  const text = fs.readFileSync(path.join(STATE_DIR, 'worldview.md'), 'utf8').replace(/^#.*$/m, '').trim();
  const sentences = text.split(/(?<=[。！？])/).map((s) => s.trim()).filter((s) => s.length > 8);
  for (const s of sentences.slice(0, 4)) {
    lines.push(`我答应自己一直记得：${s.slice(0, 120)}`);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn('读取世界观失败:', error.message);
}

// 4) 记忆归档 → 挑「爸爸提醒过的事」「她自己记下的喜好」里的行
try {
  const dir = path.join(BRIDGE_DIR, 'memories');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const section = (title) => {
      const start = text.indexOf(title);
      if (start < 0) return [];
      const rest = text.slice(start + title.length);
      const end = rest.search(/\n## /);
      return (end < 0 ? rest : rest.slice(0, end)).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
    };
    for (const l of section('爸爸提醒过的事').slice(0, 6)) {
      const clean = l.replace(/^- \[[^\]]*\]\s*/, '').slice(0, 120);
      if (clean.length > 6) lines.push(`爸爸说过：${clean}`);
    }
    for (const l of section('她自己记下的喜好').slice(0, 6)) {
      const clean = l.replace(/^-\s*(\[[^\]]*\])?\s*/, '').slice(0, 120);
      if (clean.length > 6) lines.push(`我喜欢${clean}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') console.warn('读取归档失败:', error.message);
}

if (lines.length === 0) {
  console.log('没有找到可导入的内容（检查 QQ_BRIDGE_DIR 是否指向 qq-bridge 目录）');
  service.close();
  process.exit(0);
}

let ok = 0;
let skipped = 0;
for (const line of lines) {
  const r = service.write(line, { sourceType: 'user_explicit' });
  if (r?.written?.length) { ok += 1; console.log('✓', line.slice(0, 60)); }
  else { skipped += 1; console.log('· 跳过', line.slice(0, 50), JSON.stringify(r?.rejected?.[0]?.reason ?? r?.error ?? '')); }
}
console.log(`\n导入完成：写入 ${ok} 条，跳过 ${skipped} 条，scope=${scope}`);
const health = service.health({});
console.log('健康检查:', JSON.stringify(health.counts ?? health).slice(0, 300));
service.close();
