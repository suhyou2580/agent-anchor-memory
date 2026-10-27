# 部署、升级、回滚、备份与恢复

面向已经能正常聊天（SnowLuma + `qq-bridge` + DSH 在跑）的机器。

---

## 1. 安装

### 1.1 前置检查

```powershell
node --version              # 需要 >= 22.5（用到 node:sqlite）；本机 v24.22.0
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE VIRTUAL TABLE t USING fts5(x)');console.log('sqlite+FTS5 ok')"
node scripts/health.mjs     # 迁移前会提示库不存在，属正常
```

### 1.2 三步

```powershell
cd 'D:\QQ(BOT)\plug-in\anchor-memory'

# ① 数据库
node scripts/migrate.mjs
#   → {"ok":true,"applied":["001_initial_schema"],"skipped":[]}

# ② MCP 工具（纯追加到既有 snowluma-host server）
node scripts/integrate-bridge.mjs --apply
#   → {"ok":true,"status":"patched","backup":"...mcp-host-server.js.anchor-memory.bak-..."}

# ③ DSH Host 插件（回复前自动注入）
#   在 DSH 里：plugin_manager action=install_bundle target=D:\QQ(BOT)\plug-in\anchor-memory
#   → application: applied
```

**DSH 未启动时**：③ 可以等 DSH 起来后再做；①② 不依赖 DSH。

### 1.3 验证

```powershell
node scripts/integrate-bridge.mjs --check          # status: patched
node scripts/verify-mcp.mjs --call memory_health   # registered_ok/ok 都应为 true
node scripts/demo.mjs                              # 端到端演示（临时库，不碰生产数据）
node scripts/health.mjs --metrics                  # ok:true
```

然后**重启桥接**，让 QQ 会话拿到新工具：

```powershell
D:\qq-bridge\restart.bat
```

重启后在一个 QQ 会话里让模型调用 `memory_health`（工具名 `mcp__snowluma-host__memory_health`）
确认可见。

---

## 2. 配置生效顺序

```
环境变量  >  config.json  >  src/config.js 的 DEFAULT_CONFIG
```

- `config.json` 放在插件目录（可复制 `config.example.json`）。
- 改配置后：Host 插件随 HMR 重载；MCP server 需要重启桥接。
- **非法配置会让插件拒绝启动并打印原因**（这是有意的：宁可报错，不要静默降级成"记忆永远为空"）。

---

## 3. 升级

插件是纯 JS + SQLite，无原生编译，升级就是替换文件 + 跑迁移。

```powershell
# 1) 备份（见 §5）
# 2) 替换插件目录内容（保留 config.json 与 data/）
# 3) 跑迁移（幂等，只会执行新版本）
node scripts/migrate.mjs

# 4) 重启桥接 + 让 DSH 重新加载 bundle
D:\qq-bridge\restart.bat
#    DSH 侧：plugin_manager 先 set_bundle(enabled=false) 再 true，或直接 install_bundle 覆盖
```

**迁移约定**：迁移文件按文件名排序，只能追加、不能修改已发布的文件；
每个文件在单事务里执行，失败整体回滚并报错。已应用版本记录在 `schema_migrations`。

---

## 4. 回滚

按"影响面从大到小"三步，任一步都可以单独执行：

```powershell
# ① 先关自动注入（最影响体验的部分）
#    DSH: plugin_manager set_bundle target=@local/anchor-memory enabled=false

# ② 再撤 MCP 工具（恢复 mcp-host-server.js 到无本插件状态）
node scripts/integrate-bridge.mjs --remove
D:\qq-bridge\restart.bat

# ③ 数据库保留不动（随时可以再打开）
```

`integrate-bridge.mjs` 的 `--apply` 在写入后会用 `node --check` 校验语法，
校验失败会**自动还原备份**，不会留下坏文件。

彻底移除：

```powershell
# DSH: plugin_manager action=remove_bundle target=@local/anchor-memory
node scripts/integrate-bridge.mjs --remove
Remove-Item -Recurse -Force 'D:\QQ(BOT)\plug-in\anchor-memory\data'   # 删库（不可恢复）
```

---

## 5. 备份

### 5.1 在线备份（推荐，不停服务）

SQLite 处于 WAL 模式，直接 `copy` 数据库文件可能拿到不一致快照。用 SQLite 的备份语义：

```powershell
cd 'D:\QQ(BOT)\plug-in\anchor-memory'
node -e "
const {DatabaseSync}=require('node:sqlite');
const src=new DatabaseSync('data/anchor-memory.db',{readOnly:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const dst=new DatabaseSync('data/backup-'+stamp+'.db');
src.exec(\"VACUUM INTO 'data/backup-'+stamp+'.db'\");
src.close(); dst.close();
console.log('backup done');
"
```

> 如果 `VACUUM INTO` 的参数写法在你的 Node 版本上不被接受（`exec` 不接受绑定参数），
> 改用字符串拼接的绝对路径，或先停服务再复制三个文件（见 5.2）。

### 5.2 停服务冷备（最简单）

```powershell
# 1) DSH: plugin_manager set_bundle target=@local/anchor-memory enabled=false
# 2) 停桥接：D:\qq-bridge\ 下 Ctrl+C 或关掉命令行窗口
Copy-Item 'D:\QQ(BOT)\plug-in\anchor-memory\data\anchor-memory.db*' 'D:\backup\' -Force
```

WAL 模式下 `.db`、`.db-wal`、`.db-shm` **三个文件要一起复制**，否则会丢最近提交。

### 5.3 备份里有什么 / 没有什么

| 有 | 没有 |
|---|---|
| 记忆节点、锚点、关系边、全文索引 | 原始聊天正文（默认不存） |
| 审计事件（不含正文） | 平台侧聊天记录（QQ/腾讯） |
| 删除抑制指纹（HMAC，不含明文） | HMAC 密钥本身，如果你用环境变量提供的话 |

⚠️ **删除的边界**：用户删除一条记忆后，**历史备份里仍然有它**。备份保留策略必须独立管理：
要么定期重建备份（删完就重建），要么把备份视为"删除前的历史副本"并在隐私说明里写清。

---

## 6. 恢复

```powershell
# 1) 关自动注入 + 停桥接（同 §5.2）
# 2) 把备份拷回 data/ 并改名为 anchor-memory.db（先删掉旧的三个文件）
Copy-Item 'D:\backup\anchor-memory.db' 'D:\QQ(BOT)\plug-in\anchor-memory\data\anchor-memory.db' -Force
# 3) 校验
node scripts/health.mjs
#   → ok:true, integrity:"ok", counts 与备份时一致
# 4) 需要时补跑迁移（跨版本恢复）
node scripts/migrate.mjs
# 5) 重新开启自动注入 + 启动桥接
```

**跨版本恢复**：旧库恢复到新代码时，`migrate` 会补齐新迁移；新库恢复到旧代码不会被识别，
会报 schema 版本未知 —— 此时应升级代码而不是改库。

---

## 7. 日常运维

```powershell
node scripts/health.mjs --metrics            # 健康 + 周度指标（召回数/空召回率/P95/删除失败）
npm run test                                 # 129 个测试（改配置后至少跑一次）
node scripts/eval-recall.mjs                 # 召回质量（改了阈值就重跑）
node scripts/bench.mjs --nodes 10000         # 延迟（改了检索逻辑就重跑）
```

建议的定期动作：

| 周期 | 动作 |
|---|---|
| 每天 | `daily` 维护（阶段降级/过期/删除重试）+ 备份 |
| 每周 | 看 `memory_health --metrics`：`purge_pending` 是否 >0、`empty_recall_rate`、`p95_latency_ms`、`delete_failures` |
| 每月 | `eval-recall.mjs` 复核召回；检查 `data/` 体积增长 |

---

## 8. 数据库结构升级注意

- 迁移只能追加；已发布的迁移文件**不要修改**（否则不同机器 `schema_migrations` 会不一致）。
- 新字段一律 `NULL` 可空并提供默认值，避免旧数据升级失败。
- 加索引用 `CREATE INDEX IF NOT EXISTS`；加表用 `CREATE TABLE IF NOT EXISTS`。
- 破坏性变更（删列/改类型）在本版本没有被使用，SQLite 也不支持 `DROP COLUMN` 的旧版本子集 ——
  真要做就新建表 + 迁移数据。
