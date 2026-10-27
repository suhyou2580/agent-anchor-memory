#!/usr/bin/env node
/**
 * 真实接入验证：用 stdio 直接和 qq-bridge 的 `snowluma-host` MCP server 说 MCP 协议，
 * 确认记忆工具真的注册成功、并且**原有的 snowluma_status 工具没有被打坏**。
 *
 *   node scripts/verify-mcp.mjs
 *   node scripts/verify-mcp.mjs --call memory_health
 *
 * 这是"接入验证"，不是单元测试：它跑的是 DSH 真正会 spawn 的那个进程。
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR ?? 'D:\\qq-bridge';
const SERVER = path.join(BRIDGE_DIR, 'src', 'mcp-host-server.js');
const args = process.argv.slice(2);
const callIndex = args.indexOf('--call');
const callTool = callIndex >= 0 ? args[callIndex + 1] : null;
const selfTest = args.includes('--selftest');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANCHOR_MEMORY_LOG_LEVEL: process.env.ANCHOR_MEMORY_LOG_LEVEL ?? 'error' },
});

let buffer = '';
const pending = new Map();
let nextId = 1;
const stderrChunks = [];

child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

const responses = [];
child.stdout.on('data', (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    responses.push(message);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
}

const out = { server: SERVER };
try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'anchor-memory-verify', version: '1.0.0' },
  });
  out.initialize = init.result?.serverInfo ?? null;
  notify('notifications/initialized');

  const listed = await request('tools/list', {});
  const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
  out.tool_count = tools.length;
  out.memory_tools = tools.filter((name) => name.includes('memory_'));
  out.existing_tools = tools.filter((name) => !name.includes('memory_'));
  out.registered_ok = out.memory_tools.length > 0;
  out.original_tool_intact = tools.includes('snowluma_status');
  out.expected_prefix_ok = out.memory_tools.every((name) => name.startsWith('mcp__snowluma-host__memory_') || name.startsWith('memory_'));

  if (callTool) {
    const target = tools.find((name) => name === callTool || name.endsWith(callTool));
    if (!target) {
      out.call = { ok: false, error: `找不到工具 ${callTool}` };
    } else {
      const called = await request('tools/call', { name: target, arguments: {} });
      let text = called.result?.content?.[0]?.text ?? '';
      try {
        text = JSON.parse(text);
      } catch {
        /* 保留原文本 */
      }
      out.call = { tool: target, ok: !called.result?.isError, result: text };
    }
  }

  // 端到端自检：通过**真实 MCP 通道**写入 → 召回 → 删除，用完即删。
  // 用一个专用 scope，绝不碰生产 scope 的数据。
  if (selfTest) {
    const scope = 'verify:selftest';
    const call = async (suffix, payload) => {
      const target = tools.find((name) => name.endsWith(suffix));
      if (!target) return { ok: false, error: `找不到工具 ${suffix}` };
      const response = await request('tools/call', { name: target, arguments: { ...payload, scope } });
      let body = response.result?.content?.[0]?.text ?? '';
      try {
        body = JSON.parse(body);
      } catch {
        /* 保留原文本 */
      }
      return { isError: Boolean(response.result?.isError), body };
    };

    const written = await call('memory_remember', { text: '我讨厌香菜，闻到就皱眉头' });
    const nodeId = written.body?.node_id ?? null;
    const recalled = await call('memory_recall', { query: '香菜' });
    const hit = (recalled.body?.memories ?? []).some((memory) => memory.node_id === nodeId);
    const forgotten = await call('memory_forget', { node_id: nodeId });
    const afterDelete = await call('memory_recall', { query: '香菜' });
    const gone = !(afterDelete.body?.memories ?? []).some((memory) => memory.node_id === nodeId);

    out.selftest = {
      written: Boolean(nodeId),
      node_id: nodeId,
      recalled: hit,
      deleted: forgotten.body?.ok === true,
      cleaned_stages: forgotten.body?.cleaned ?? null,
      gone_after_delete: gone,
      ok: Boolean(nodeId) && hit && forgotten.body?.ok === true && gone,
    };
    if (!out.selftest.ok) out.ok = false;
  }
  out.ok = out.registered_ok && out.original_tool_intact;
} catch (error) {
  out.ok = false;
  out.error = String(error?.message ?? error);
} finally {
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 100);
}

console.log(JSON.stringify(out, null, 2));
if (stderrChunks.join('').trim().length > 0) {
  console.log('\n--- server stderr ---');
  console.log(stderrChunks.join('').trim().slice(0, 2000));
}
if (!out.ok) process.exitCode = 1;
