# MCP 工具接线说明

8 个 `memory_*` 工具不是新开一个 MCP server，而是**追加到既有的 `snowluma-host` server** 上。
原因：QQ 会话有执行期工具白名单，只放行既有命名空间；新开 server 会被拒绝。

## 自动打补丁

```powershell
node scripts/integrate-bridge.mjs --apply    # 打（幂等，已打过会返回 already_patched）
node scripts/integrate-bridge.mjs --check    # 查
node scripts/integrate-bridge.mjs --remove   # 撤
```

它会在 `qq-bridge/src/mcp-host-server.js` 里插入一段被注释包围的代码：

```js
// === anchor-memory MCP tools (additive) BEGIN ===
// 本段由 plug-in/anchor-memory/scripts/integrate-bridge.mjs 维护；整段删除即完全回滚。
try {
  const anchorToolsUrl = process.env.ANCHOR_MEMORY_TOOLS_URL || "file:///<插件绝对路径>/src/mcp-tools.js";
  const mod = await import(anchorToolsUrl);
  const registered = mod.registerMemoryTools(server, process.env);
  if (registered.failed?.length) {
    console.error('[anchor-memory] 部分记忆工具注册失败：' + JSON.stringify(registered.failed));
  }
} catch (error) {
  console.error('[anchor-memory] 记忆工具不可用（不影响其它工具）：' + String(error?.message ?? error));
}
// === anchor-memory MCP tools (additive) END ===
```

特点：

- **纯追加**：不改动原有工具，注册失败只打日志，不会拖垮 server
- **有备份**：打补丁前生成 `mcp-host-server.js.anchor-memory.bak-<时间戳>`
- **可整段删除**：删掉两个注释之间的内容即完全回滚

## 打完补丁之后

1. 重启桥接（`D:\qq-bridge\restart.bat` 或手动拉 `node src/bridge.js`），让 QQ 会话拿到新工具
2. 验证：
   ```powershell
   node scripts/verify-mcp.mjs --call memory_health
   # 期望 registered_ok / ok 都为 true
   ```
3. 在真实会话里让她调用一次 `mcp__snowluma-host__memory_health` 确认可见

## 注意

- MCP server 是**每次 DSH 启动时**拉起的子进程；改完 `mcp-host-server.js` 必须重启 DSH 或桥接，热更不生效
- 工具描述会随每次请求一起发送（约 1~2k token），这是 MCP 的固有开销，无法避免
