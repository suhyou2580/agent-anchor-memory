#!/usr/bin/env node
/**
 * 健康检查 CLI：退出码 0 表示健康，1 表示有错误（warnings 不影响退出码）。
 *
 *   node scripts/health.mjs
 *   node scripts/health.mjs --metrics     # 附带周度指标
 *   node scripts/health.mjs --scope qq:owner
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMemoryService, closeAllMemoryServices } from '../src/service.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = getMemoryService({
  configFile: process.env.ANCHOR_MEMORY_CONFIG || path.join(baseDir, 'config.json'),
  baseDir,
});
const scope = valueOf('--scope', service.cfg.defaultScope);

try {
  const health = service.health();
  const payload = { ...health };
  if (flag('--metrics')) payload.weekly = service.weekly({ scope });
  console.log(JSON.stringify(payload, null, 2));
  if (!health.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  closeAllMemoryServices();
}
