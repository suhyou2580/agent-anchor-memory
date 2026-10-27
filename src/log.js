/**
 * 最小日志器：分级、可关闭、**永不写记忆正文**。
 *
 * 单独实现而不复用宿主 logger，是为了让插件在 MCP server 进程里也能用同一套日志
 * （MCP 进程的 stdout 是协议通道，必须写 stderr 或文件）。
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function parseLevel(value) {
  const name = String(value ?? 'info').toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * @param {{ file?: string, level?: string, stderr?: boolean }} options
 */
export function createLogger(options = {}) {
  const level = parseLevel(options.level ?? process.env.ANCHOR_MEMORY_LOG_LEVEL);
  const file = options.file ?? process.env.ANCHOR_MEMORY_LOG_FILE ?? null;
  const useStderr = options.stderr !== false;

  function rotateIfNeeded() {
    if (!file) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* 文件不存在或轮转失败：继续写 */
    }
  }

  function write(lvl, message, meta) {
    if (LEVELS[lvl] > level) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${
      meta === undefined ? '' : ` ${safeJson(meta)}`
    }`;
    if (useStderr) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    }
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        rotateIfNeeded();
        fs.appendFileSync(file, `${line}\n`);
      } catch {
        /* 日志失败不能影响主流程 */
      }
    }
  }

  return {
    level,
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}

function safeJson(value) {
  try {
    // 只保留原始类型的短值，避免把对象树（可能含正文）泄进日志。
    if (typeof value !== 'object' || value === null) return String(value).slice(0, 200);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'object') continue;
      out[key] = typeof item === 'string' ? item.slice(0, 120) : item;
    }
    return JSON.stringify(out);
  } catch {
    return '"<unserializable>"';
  }
}

export const logger = createLogger();
