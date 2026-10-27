/**
 * SQLite 访问层：打开数据库、PRAGMA、版本迁移、事务、健康检查。
 *
 * 用 Node 24 内置的 `node:sqlite`（DatabaseSync），不引入任何原生依赖 ——
 * 部署机上不需要编译 better-sqlite3。实测版本与 FTS5 可用性见 docs/ENV-REPORT.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');

/** 迁移文件按文件名排序执行，文件名即版本号。 */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) throw new Error(`迁移目录不存在：${dir}`);
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

// node:sqlite 在 Node 22.5+ 才有；用动态 import 让缺失时给出**可读的错误**而不是加载期 SyntaxError。
let sqliteModule = null;
let sqliteLoadError = null;
try {
  sqliteModule = await import('node:sqlite');
} catch (error) {
  sqliteLoadError = error;
}

function loadSqlite() {
  if (!sqliteModule || typeof sqliteModule.DatabaseSync !== 'function') {
    throw new Error(
      '当前 Node 不支持 node:sqlite（需要 Node >= 22.5；本项目在 Node 24 上验证）。'
      + (sqliteLoadError ? ` 加载失败原因：${sqliteLoadError.message}` : ''),
    );
  }
  return sqliteModule;
}

/**
 * 连接并初始化数据库。
 * @param {string} databasePath - 绝对路径，`:memory:` 用于测试
 * @param {{ migrationsDir?: string, ftsOk?: boolean }} [options]
 */
export function openDatabase(databasePath, options = {}) {
  const isMemory = databasePath === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(databasePath);

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  if (!isMemory) {
    db.exec('PRAGMA journal_mode = WAL');
  }

  return {
    db,
    databasePath,
    isMemory,
    migrationsDir: options.migrationsDir ?? MIGRATIONS_DIR,
    closed: false,
  };
}

/** 数据库是否支持 FTS5（缺少时插件仍要能跑，但须明确报告降级）。 */
export function probeFts5(handle) {
  try {
    handle.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)");
    handle.db.exec('DROP TABLE IF EXISTS __fts_probe');
    return true;
  } catch {
    return false;
  }
}

function appliedVersions(handle) {
  handle.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return new Set(handle.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
}

/**
 * 执行尚未应用的迁移。重复执行是安全的：已记录的版本会跳过。
 * 每个迁移文件在**单个事务**内执行，失败则整体回滚。
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function migrate(handle, { dir } = {}) {
  const migrationsDir = dir ?? handle.migrationsDir;
  const files = listMigrationFiles(migrationsDir);
  const done = appliedVersions(handle);
  const applied = [];
  const skipped = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      handle.db.exec(sql);
      handle.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
      handle.db.exec('COMMIT');
      applied.push(version);
    } catch (error) {
      try {
        handle.db.exec('ROLLBACK');
      } catch {
        /* rollback 本身失败时保留原始错误 */
      }
      throw new Error(`迁移 ${file} 失败：${error.message}`);
    }
  }
  return { applied, skipped };
}

/** 当前 schema 版本（最后一条已应用迁移）。 */
export function schemaVersion(handle) {
  const rows = appliedVersions(handle);
  return [...rows].sort().at(-1) ?? null;
}

let savepointSeq = 0;

/**
 * 在事务中执行同步函数。支持嵌套（内层用 SAVEPOINT）。
 * @template T
 * @param {object} handle - openDatabase 的返回值
 * @param {() => T} fn - 事务体
 * @returns {T}
 */
export function transaction(handle, fn) {
  const db = handle.db;
  const depth = handle.__txDepth ?? 0;
  const name = `sp_${++savepointSeq}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  handle.__txDepth = depth + 1;
  try {
    const result = fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    handle.__txDepth = depth;
    return result;
  } catch (error) {
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${name}`);
    } catch {
      /* 保留原始错误 */
    }
    handle.__txDepth = depth;
    throw error;
  }
}

/** 结构化健康检查结果；供 memory_health 与启动自检使用。 */
export function health(handle, extra = {}) {
  const out = {
    ok: true,
    databasePath: handle.databasePath,
    schemaVersion: null,
    fts5: false,
    foreignKeys: null,
    journalMode: null,
    counts: {},
    errors: [],
    warnings: [],
  };
  try {
    out.schemaVersion = schemaVersion(handle);
    out.fts5 = probeFts5(handle);
    out.foreignKeys = handle.db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    out.journalMode = handle.db.prepare('PRAGMA journal_mode').get().journal_mode;
    const integrity = handle.db.prepare('PRAGMA quick_check').get();
    out.integrity = integrity ? Object.values(integrity)[0] : 'unknown';
    if (out.integrity !== 'ok') {
      out.ok = false;
      out.errors.push(`quick_check=${out.integrity}`);
    }
    for (const table of ['memory_nodes', 'anchors', 'node_anchors', 'memory_edges', 'memory_events']) {
      out.counts[table] = handle.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    }
    const ftsCount = out.fts5 ? handle.db.prepare('SELECT COUNT(*) AS c FROM memory_fts').get().c : 0;
    const liveCount = handle.db
      .prepare("SELECT COUNT(*) AS c FROM memory_nodes WHERE state <> 'deleted'")
      .get().c;
    out.counts.memory_fts = ftsCount;
    if (out.fts5 && ftsCount !== liveCount) {
      out.warnings.push(`FTS 行数(${ftsCount}) 与未删除节点数(${liveCount}) 不一致，可运行 lifecycle repairIndex`);
    }
    const pendingPurge = handle.db.prepare('SELECT COUNT(*) AS c FROM memory_nodes WHERE purge_pending = 1').get().c;
    out.counts.purge_pending = pendingPurge;
    if (pendingPurge > 0) out.warnings.push(`有 ${pendingPurge} 条删除未完成，需要重试（不会参与召回）`);
  } catch (error) {
    out.ok = false;
    out.errors.push(String(error?.message ?? error));
  }
  return { ...out, ...extra };
}
