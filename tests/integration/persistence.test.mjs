import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createMemoryService } from '../../src/service.js';
import { openDatabase, migrate, schemaVersion, transaction } from '../../src/db.js';
import { tempDbPath, firstWritten } from '../helpers.mjs';

const T0 = new Date('2026-10-19T10:00:00.000Z');
const T1 = new Date('2026-10-19T11:00:00.000Z');

test('重启后数据仍在：关闭再打开同一个数据库文件，记忆与索引都完整', () => {
  const databasePath = tempDbPath('persist');
  const cfg = { databasePath, defaultScope: 'qq:test' };

  const first = createMemoryService({ baseDir: undefined, config: cfg });
  const nodeId = firstWritten(first.write('我下周三要去成都出差', { now: T0 }));
  assert.ok(nodeId);
  first.close();

  const second = createMemoryService({ baseDir: undefined, config: cfg });
  try {
    const node = second.detail(nodeId).memory;
    assert.equal(node.canonical_text, '我下周三要去成都出差');
    const recalled = second.recall('成都出差', { now: T1 });
    assert.equal(recalled.memories.length, 1, '重启后全文索引必须仍然可用');
    assert.equal(second.health().ok, true);
  } finally {
    second.close();
    fs.rmSync(databasePath, { recursive: true, force: true });
  }
});

test('迁移可重复执行：第二次打开不再应用任何迁移且数据不丢', () => {
  const databasePath = tempDbPath('migrate');
  const first = openDatabase(databasePath);
  const firstRun = migrate(first);
  assert.deepEqual(firstRun.applied, ['001_initial_schema']);
  first.db.close();

  const second = openDatabase(databasePath);
  try {
    const secondRun = migrate(second);
    assert.deepEqual(secondRun.applied, [], '重复迁移不得再执行任何步骤');
    assert.deepEqual(secondRun.skipped, ['001_initial_schema']);
    assert.equal(schemaVersion(second), '001_initial_schema');
    assert.equal(second.db.prepare('SELECT COUNT(*) AS c FROM memory_nodes').get().c, 0);
  } finally {
    second.db.close();
    fs.rmSync(databasePath, { recursive: true, force: true });
  }
});

test('外键开启、WAL 开启、quick_check 通过', () => {
  const databasePath = tempDbPath('pragma');
  const handle = openDatabase(databasePath);
  try {
    migrate(handle);
    assert.equal(handle.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(String(handle.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    const check = handle.db.prepare('PRAGMA quick_check').get();
    assert.equal(Object.values(check)[0], 'ok');
  } finally {
    handle.db.close();
    fs.rmSync(databasePath, { recursive: true, force: true });
  }
});

test('事务失败会整体回滚，不留半成品节点', () => {
  const databasePath = tempDbPath('tx');
  const handle = openDatabase(databasePath);
  try {
    migrate(handle);
    assert.throws(() => {
      transaction(handle, () => {
        handle.db
          .prepare(
            `INSERT INTO memory_nodes (node_id, owner_scope, memory_type, tier, stage, state, source_type, strength_base, strength_base_at, created_at, updated_at)
             VALUES ('M_rollback', 'qq:test', 'fact', 'normal', 'full', 'active', 'user_explicit', 1, 'x', 'x', 'x')`,
          )
          .run();
        throw new Error('故意失败');
      });
    }, /故意失败/);
    assert.equal(handle.db.prepare("SELECT COUNT(*) AS c FROM memory_nodes WHERE node_id = 'M_rollback'").get().c, 0);
  } finally {
    handle.db.close();
    fs.rmSync(databasePath, { recursive: true, force: true });
  }
});

test('并发写入不会互相破坏（同一进程串行事务 + WAL）', () => {
  const { service, cleanup } = (() => {
    const databasePath = tempDbPath('concurrent');
    const svc = createMemoryService({ config: { databasePath, defaultScope: 'qq:test' } });
    return {
      service: svc,
      cleanup: () => {
        svc.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
      },
    };
  })();
  try {
    const texts = [
      '我讨厌香菜',
      '我喜欢喝美式咖啡',
      '我打算下个月去爬山',
      '我养了一只叫豆豆的猫',
      '我下周三要去成都出差',
    ];
    for (const text of texts) {
      const result = service.write(text, { now: T0 });
      assert.ok(result.ok, `写入失败：${text}`);
    }
    assert.equal(service.list({}).total, texts.length);
    assert.equal(service.health().counts.memory_fts, service.health().counts.memory_nodes, 'FTS 行数必须与节点数一致');
  } finally {
    cleanup();
  }
});
