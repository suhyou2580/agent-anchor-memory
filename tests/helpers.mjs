/**
 * 测试辅助：每个用例一个独立数据库文件（不是 :memory:），
 * 因为要验证 WAL、重启持久性、迁移可重复执行这些只有真实文件才成立的性质。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../src/service.js';

let counter = 0;

export function tempDbPath(label = 'mem') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-memory-${label}-`));
  counter += 1;
  return path.join(dir, `db-${counter}.sqlite`);
}

/**
 * 建一个测试用服务。
 * @param {object} [overrides] - 覆盖默认配置的片段
 */
export function makeService(overrides = {}) {
  const databasePath = overrides.databasePath ?? tempDbPath();
  const service = createMemoryService({
    baseDir: path.dirname(databasePath),
    config: {
      databasePath,
      defaultScope: 'qq:test',
      ...overrides,
    },
  });
  const cleanup = () => {
    try {
      service.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔文件句柄还没释放，清理失败不影响断言 */
    }
  };
  return { service, databasePath, cleanup };
}

/** 常用断言辅助：从 write 结果里取第一条 node_id。 */
export function firstWritten(result) {
  return result?.written?.[0]?.node_id ?? null;
}

/** 固定时间点，便于时间模拟测试。 */
export function atDaysFromNow(days, base = new Date('2026-01-01T00:00:00.000Z')) {
  return new Date(base.getTime() + days * 86400000);
}
