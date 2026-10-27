#!/usr/bin/env node
/**
 * 把记忆工具挂到 qq-bridge 既有的 `snowluma-host` MCP server 上（**纯追加**）。
 *
 * 为什么必须挂在这里而不是新开 MCP server：
 *   QQ 会话的执行期工具白名单（plugins/qq-agent-presets/qq-tool-restrict.mjs）只放行
 *   mcp__snowluma__ / mcp__snowluma-host__ / mcp__web-search-safe__ / mcp__phone__ 四个命名空间。
 *   新开 serverName 会得到别的 mcp__xxx__ 前缀，工具会在**执行期被拒绝**。
 *   挂到既有的 snowluma-host server 上，工具名是 mcp__snowluma-host__memory_*，
 *   无需修改任何 QQ agent 机制（唤醒 / 分条 / 提示词 / 白名单都不动）。
 *
 * 用法：
 *   node scripts/integrate-bridge.mjs --check     # 只检测是否已接入
 *   node scripts/integrate-bridge.mjs --apply     # 写入（自动备份 + 语法检查）
 *   node scripts/integrate-bridge.mjs --remove    # 回滚（恢复成无本插件状态）
 *
 * 环境变量：
 *   QQ_BRIDGE_DIR    qq-bridge 目录（默认 D:\qq-bridge）
 *   ANCHOR_MEMORY_DIR 本插件目录（默认脚本上一级）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = process.env.ANCHOR_MEMORY_DIR ?? path.resolve(HERE, '..');
const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR ?? 'D:\\qq-bridge';
const TARGET = path.join(BRIDGE_DIR, 'src', 'mcp-host-server.js');

const BEGIN = '// === anchor-memory MCP tools (additive) BEGIN ===';
const END = '// === anchor-memory MCP tools (additive) END ===';

const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : args.includes('--remove') ? 'remove' : 'check';

function buildBlock() {
  const toolsUrl = pathToFileURL(path.join(PLUGIN_DIR, 'src', 'mcp-tools.js')).href;
  return [
    BEGIN,
    '// 本段由 plug-in/anchor-memory/scripts/integrate-bridge.mjs 维护；整段删除即完全回滚。',
    '// 只追加 memory_* 工具，不改动本 server 原有的工具与任何 QQ agent 机制。',
    'try {',
    `  const anchorToolsUrl = process.env.ANCHOR_MEMORY_TOOLS_URL || ${JSON.stringify(toolsUrl)};`,
    '  const { registerMemoryTools } = await import(anchorToolsUrl);',
    '  const zod = await import(\'zod\');',
    '  const z = zod.z ?? zod.default?.z ?? zod.default;',
    '  const registered = registerMemoryTools(server, { z });',
    '  if (registered.failed.length > 0) {',
    '    console.error(\'[anchor-memory] 部分记忆工具注册失败：\' + JSON.stringify(registered.failed));',
    '  }',
    '} catch (error) {',
    '  // 记忆库不可用时降级：本 MCP server 的其它工具照常可用（等价于"无记忆模式"）。',
    '  console.error(\'[anchor-memory] 记忆工具不可用（不影响其它工具）：\' + String(error?.message ?? error));',
    '}',
    END,
  ].join('\n');
}

function readTarget() {
  if (!fs.existsSync(TARGET)) {
    throw new Error(`找不到 ${TARGET}；若 qq-bridge 不在默认位置，请设置 QQ_BRIDGE_DIR`);
  }
  return fs.readFileSync(TARGET, 'utf8');
}

function isPatched(text) {
  return text.includes(BEGIN) && text.includes(END);
}

function report(status, extra = {}) {
  console.log(JSON.stringify({ ok: true, mode, target: TARGET, status, ...extra }, null, 2));
}

function syntaxCheck(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

function apply() {
  let text = readTarget();
  if (isPatched(text)) {
    report('already_patched');
    return;
  }
  const anchor = 'await server.connect(new StdioServerTransport());';
  if (!text.includes(anchor)) {
    throw new Error(`在 ${TARGET} 里找不到 ${anchor} —— 该文件结构已变化，请手工接入（见 README「接入」一节）`);
  }
  const backup = `${TARGET}.anchor-memory.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, text, 'utf8');
  // 必须在 connect 之前注册工具（connect 之后 server 已开始处理请求）
  text = text.replace(anchor, `${buildBlock()}\n\n${anchor}`);
  fs.writeFileSync(TARGET, text, 'utf8');
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    // 语法检查失败则立刻回滚，绝不留下坏文件
    fs.writeFileSync(TARGET, fs.readFileSync(backup, 'utf8'), 'utf8');
    throw new Error(`接入后语法检查失败，已回滚：${String(error?.message ?? error)}`);
  }
  report('patched', { backup, note: '重启 qq-bridge（restart.bat）后生效' });
}

function remove() {
  let text = readTarget();
  if (!isPatched(text)) {
    report('not_patched');
    return;
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) throw new Error('标记不完整，请手工检查');
  text = `${text.slice(0, start)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(TARGET, text, 'utf8');
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    throw new Error(`回滚后语法检查失败，请检查备份：${String(error?.message ?? error)}`);
  }
  report('removed', { note: '重启 qq-bridge 后生效；原有 snowluma_status 工具不受影响' });
}

try {
  if (mode === 'apply') apply();
  else if (mode === 'remove') remove();
  else report(isPatched(readTarget()) ? 'patched' : 'not_patched');
} catch (error) {
  console.error(JSON.stringify({ ok: false, mode, target: TARGET, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
}
