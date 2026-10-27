#!/usr/bin/env node
/**
 * 数据库迁移 CLI。
 *
 *   node scripts/migrate.mjs                # 应用未应用的迁移（幂等）
 *   node scripts/migrate.mjs --db <path>    # 指定数据库文件
 *   node scripts/migrate.mjs --dry-run      # 只列出将会应用哪些迁移
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate, listMigrationFiles } from '../src/db.js';
import { loadConfig, resolveDatabasePath } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig({ filePath: process.env.ANCHOR_MEMORY_CONFIG || path.join(baseDir, 'config.json') });
const databasePath = valueOf('--db', resolveDatabasePath(cfg, baseDir));

if (flag('--dry-run')) {
  console.log(JSON.stringify({ databasePath, migrations: listMigrationFiles() }, null, 2));
  process.exit(0);
}

const handle = openDatabase(databasePath);
try {
  const result = migrate(handle);
  console.log(JSON.stringify({ ok: true, databasePath, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, databasePath, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  handle.db.close();
}
