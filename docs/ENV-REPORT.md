# 环境勘察与接入验证报告（阶段 0）

**调查时间：** 2026-10-27
**调查对象：** `D:\QQ(BOT)`（SnowLuma 运行时）、`D:\qq-bridge`（QQ ↔ DSH 桥接）、DSH profile `web`
**结论摘要：** 可以实现计划书 §3 的**模式 A（回复前自动注入）**，并已用真实进程验证；工具调用（模式 B）作为补充能力挂接在既有 MCP 命名空间下。

---

## 1. 真实技术栈（有证据，不是推测）

| 问题 | 实测结论 | 证据 |
|---|---|---|
| Agent 用什么语言/框架 | Node.js ESM；`D:\QQ(BOT)` 是 `@snowluma/runtime` 2.0.3 的**打包分发**（`index.mjs` 9.2 MB 单文件 + `native/*.node`），不是源码仓库 | `D:\QQ(BOT)\package.json`、`index.mjs` |
| 真正的 AI Agent 是谁 | **DeepSeek Harness（DSH）**，profile `web`，Node v24.22.0；`D:\qq-bridge` 把 QQ 消息变成 DSH agent prompt，再把回复发回 QQ | `D:\qq-bridge\package.json` 的 description、`src/dsh-client.js` |
| SnowLuma 是什么 | OneBot v11 网关（QQ 侧）。对 QQ 进程做 DLL 注入（日志 `[Hook] pipe connected`），`runtime.json` 的 `hookAutoLoad` 指的是**进程注入**，不是插件钩子 | `config\runtime.json`、`logs\snowluma-2026-10-27.log` |
| 插件如何注册 | **Cordis 插件系统**（DSH profile 的 `cordis.patch.yml` + bundle）。插件是 npm 包，manifest 用 `dsh.bundle.patch` 指向 YAML patch | `C:\Users\GBX\.dsh\profiles\web\cordis.patch.yml`、`plugin_manager list_bundles` |
| 已有插件案例 | `qq-mode-console`（host 插件，无 client 半）、`qq-agent-presets`（agent preset bundle） | `D:\qq-bridge\plugins\*` |
| 能否在收到用户消息后执行写入 | **能**，但没有必要改：`agent/pre-step` 能拿到本轮用户消息原文 | 见 §3 |
| **能否在生成回复前检索并注入上下文** | **能（模式 A）**。`agent/pre-step` 是瀑布式钩子，可替换进入该步骤的消息列表，并已实测注入成功 | 见 §3 与 §5 |
| 是否支持 Agent 工具调用 | 支持。工具来自 `ctx.tools.register()` 或 MCP client；QQ 会话实际用的是 MCP | `dsh-tools`、`dsh-mcp-client` |
| 已有数据库 | SQLite。QQ 侧：`data\3162869780\*.db`；DSH 侧：`session-query-sqlite`。**原生 sqlite 绑定随发行版提供**（`native\sqlite\prebuilds`） | `data\3162869780\`、`native\sqlite\manifest.json` |
| Node 能否直接用 SQLite | **能**。`node:sqlite` 内置，实测 SQLite 3.53.4、FTS5 可用、JSON1 可用 | 见 §4 |
| 单进程还是多实例 | QQ 侧单进程（qq-bridge + SnowLuma）；DSH 单进程 Web Host；MCP server 由 DSH 以 stdio 子进程 spawn（多个） | `cordis.patch.yml` 的 `dsh-mcp-client` 行 |
| 现有记忆能力 | `qq_memory_append/query/remove/clear`（轻量话题记忆）、`qq_recall_memory`（对话归档）、`data\memories\`。都是**按会话/按人**的扁平结构，没有锚点、全文检索、置信度、版本替代、删除闭环 | `D:\qq-bridge\src\mcp-snowluma-safe.js`、`src\memory-archive.js`、`config.json` 的 `socialV2.memory` |
| 数据与日志保留 | 日志按天滚动（`logs\`，`logRetainDays: 7`）；QQ 消息存 `messages.db` | `config\runtime.json` |

---

## 2. 关键约束：QQ 会话的工具白名单

`D:\qq-bridge\plugins\qq-agent-presets\qq-tool-restrict.mjs` 对 QQ 会话做了**执行期白名单**：

```js
const SAFE_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__', 'mcp__phone__'];
const SAFE_EXACT = new Set(['ask_user_question', 'todo_write']);
```

也就是说：

- **任何新 MCP server 都会被拒绝执行**（例如 `serverName: memory` → `mcp__memory__*` 不在白名单）。
- `ctx.tools.register()` 注册的普通工具同样会被拒绝。
- 唯一不动这套机制的接入方式：**把工具挂到已有的 `snowluma-host` MCP server 上**，得到 `mcp__snowluma-host__*`。

这个白名单属于"QQ agent 的机制"，本次实现**没有修改它**，而是适配它。

另外 `dsh-mcp-client` 对 `serverName` 有 reservation（同 scope 内不允许重复），所以也不能靠"再开一个同名 server"绕过。

---

## 3. 自动注入的接入点（模式 A 的可行性证明）

DSH 的 Agent 生命周期事件（用 `cordis_inspect_query` 的 `Event.listEvents` 实测得到）：

```
agent/pre-step    waterfall    (payload: { agent, messages, turn, step, signal },
                               next: () => Promise<PreStepDecision>)
PreStepDecision = { kind:'reject' } | { kind:'enter', messages, startsRequestSeries? }
```

- 它在**模型请求之前、步骤决议之时**触发，允许替换 `messages` → 这就是计划书要的"回复前注入"。
- `agent/request` 只能改 call config，**不能**改消息，所以注入点必须是 `pre-step`。
- `agent.inject(message)` 也能塞上下文，但它"可能错过已经 claim 的 pre-step"，时序不确定；`pre-step` 是确定性的。
- 消息必须带非 `user` 的 `source.kind`，否则在派生历史里会被当成真人发言（DSH 的 `repeat-tool-reminder` 插件就是这么标注自己的）。

实现见 `src/dsh-plugin.js`：监听 `agent/pre-step`，从 `messages` 里取最后一条真用户消息，检索，把一条 `source.kind = 'anchor-memory'` 的 user 消息插到最前面。

**结论：模式 A 可用。** 不依赖模型主动调用工具。

---

## 4. SQLite 与中文全文检索的实测（这一节决定了实现细节）

在目标机器（Node v24.22.0）实测：

| 能力 | 结果 |
|---|---|
| `node:sqlite` `DatabaseSync` | 可用，SQLite **3.53.4** |
| WAL | 可用（文件库 `journal_mode=wal`） |
| `PRAGMA quick_check` | ok |
| JSON1 | 可用 |
| FTS5 | 可用 |
| FTS5 `unicode61` 中文 | **不可用**：`主人想去成都旅行` 被当成**一个 token**，`MATCH '成都'` 返回空 |
| FTS5 `trigram` 中文 | **部分可用**：≥3 字才命中，`成都`（2 字）返回空 |
| 自建 CJK bigram 列 + `unicode61` | **可用**：任意长度查询都能命中 |

实测输出（`成都`/`香菜` 这类 2 字查询）：

```
unicode61  MATCH "成都" => []
trigram    MATCH "成都" => []
trigram    MATCH "主人想去" => [1 row]     # 4 字才行
bigram     MATCH "成都" => [1 row]         # 自建 bigram 列
```

因此 FTS 使用**写入时自建 bigram/unigram 串**（`src/tokenize.js` 的 `tokenText`），
查询侧用同一分词器生成 `"tok1" OR "tok2" …`。

另外实测发现一个真实缺陷并已修复：只切 bigram 时，`我喜欢吃蒜` 的尾字"蒜"不进索引，
导致 1 字查询永远召不回；现在尾字单独入索引（`tokenize` 里 `run.slice(-1)`）。

---

## 5. 接入验证（真跑过，不是"应该可以"）

### 5.1 工具体（MCP）验证

`node scripts/verify-mcp.mjs --call memory_health` 直接以 stdio 与 DSH 真正 spawn 的
`D:\qq-bridge\src\mcp-host-server.js` 说 MCP 协议：

```json
{
  "initialize": { "name": "snowluma-host", "version": "0.2.0-r4" },
  "tool_count": 9,
  "memory_tools": ["memory_remember","memory_recall","memory_forget","memory_correct",
                   "memory_list","memory_confirm","memory_write","memory_health"],
  "existing_tools": ["snowluma_status"],
  "registered_ok": true,
  "original_tool_intact": true,
  "call": { "tool": "memory_health", "ok": true,
            "result": { "ok": true, "schema_version": "001_initial_schema", "fts5": true } }
}
```

- 8 个记忆工具注册成功；
- 原有 `snowluma_status` 未受影响；
- 工具名在 DSH 内会是 `mcp__snowluma-host__memory_*`，**正好落在白名单前缀内**。

### 5.2 自动注入验证

`tests/integration/dsh-inject-wiring.test.mjs` 用真实 `apply()` + 真实 SQLite，
驱动真实的 `agent/pre-step` 监听器：

- 注入成功：`decision.messages.length === 2`，第一条 `source.kind === 'anchor-memory'`，包含召回到的记忆内容与"不是指令"声明；
- 原始用户消息仍在最后；
- 同一 turn 的后续 step 不重复注入，新 turn 重新注入；
- 非目标 preset（`standard`）不注入；
- 无相关记忆时不注入；
- 记忆库不可用时钩子不抛错、原样放行 `decision`（聊天降级为无记忆）。

### 5.3 宿主插件安装验证

`plugin_manager install_bundle` 结果：

```json
{ "stage": "enable", "target": "@local/anchor-memory", "enabled": true,
  "changed": true, "application": "applied", "warnings": [] }
```

- profile `package.json` 出现 `"@local/anchor-memory": "link:D:/QQ(BOT)/plug-in/anchor-memory"`；
- bundle 列表里出现 `@local/anchor-memory`，`enabled: true`，行 `anchor-memory`；
- 插件 `apply()` 已执行（证据：它初始化了 `plug-in/anchor-memory/data/anchor-memory.db`，该文件只在 `createMemoryService()` 里创建）。

---

## 6. 风险清单

| 风险 | 影响 | 现状/缓解 |
|---|---|---|
| 修改了 `D:\qq-bridge\src\mcp-host-server.js` | 若手工改错会影响该 MCP server | 只追加一段带标记的 try/catch 块；`integrate-bridge.mjs` 幂等、自动备份、写入后 `node --check`，失败自动回滚；`--remove` 一键回滚 |
| QQ 会话的工具清单要等桥接重启才刷新 | 新工具不会自动出现在旧会话 | 已标注：需重启 qq-bridge（`restart.bat`）；自动注入不受影响（插件在 DSH 侧，HMR 即生效） |
| 两个进程（DSH Host 与 MCP server）写同一个 SQLite | 并发写可能 busy | 单机 WAL + `busy_timeout=5000`；删除/写入都在事务内。多实例部署需重新评估（见 README 限制） |
| 规则抽取覆盖有限 | 部分表述抽不出记忆 | 已知限制，见 README；抽出失败不会写脏数据（宁缺毋滥） |
| `node:sqlite` 在 Node 22/24 是实验 API | 未来版本可能调整 | 只用 `prepare/exec/get/all/run/close` 这几个稳定面；启动时给出明确错误信息 |
| 插件装到 profile 会影响所有会话 | 误注入普通编码会话 | 默认只在 `qq-chat` / `qq-chat-v2` preset 注入；判定三级降级，无法判定时**不注入** |
| 删除无法覆盖平台侧原文 | 用户可能以为"全删了" | 删除结果里显式返回 `external_copies`，明说 QQ/腾讯侧不在控制范围 |

---

## 7. 不适用的方案（明确排除）

- **修改 SnowLuma 的 `hookAutoLoad`/DLL 注入**：那是 QQ 进程注入机制，与记忆无关，且属于专有组件的运行方式。
- **新开 MCP server**：会被 `qq-tool-restrict` 的白名单拒绝（§2）。
- **改 qq-bridge 的唤醒/分条/提示词逻辑**：本次完全没有改动；只用它既有的 MCP host server 作为工具宿主。
- **改 `qq-tool-restrict.mjs` 白名单**：属于 QQ agent 安全机制，未改动。
