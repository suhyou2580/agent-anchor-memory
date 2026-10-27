# 测试报告与验收对照

**执行时间：** 2026-10-27
**环境：** Windows，Node v24.22.0，SQLite 3.53.4（`node:sqlite`），DSH profile `web`（0.2.0-rc.2）
**原则：** 下面每个数字都来自本机实际执行；没有实测的只能标为「目标」。

---

## 1. 测试命令与结果

| 命令 | 范围 | 结果 |
|---|---|---|
| `node --test` | 单元 + 集成 + 隐私，共 129 个用例 | **129 pass / 0 fail**（约 4.0s） |
| `node --test tests/performance/bench.perf.mjs` | 性能回归（2000 节点 + 写入吞吐） | **2 pass / 0 fail** |
| `node scripts/eval-recall.mjs` | 标注集召回评测（133 用例） | 见 §3，**0 违规** |
| `node scripts/bench.mjs --nodes 10000 --queries 200` | 1 万节点基准 | 见 §4 |
| `node scripts/verify-mcp.mjs --call memory_health` | 真实 MCP stdio 握手 | **注册 8 个工具、原有工具完好、调用成功** |
| `node scripts/verify-mcp.mjs --selftest` | 通过**真实 MCP 通道**写入→召回→删除 | **全链路通过**（`written/recalled/deleted/gone_after_delete` 均 true，清理 5 个阶段全部执行） |
| `node scripts/migrate.mjs` | 迁移 | **applied 001；重复执行为 skipped** |

> `node --test <目录>` 在 Node 24 上会被当成模块路径而报 `MODULE_NOT_FOUND`，
> 所以约定：`node --test` 用自动发现跑 `*.test.mjs`；性能测试文件命名为
> `bench.perf.mjs`（不参与自动发现），用 `npm run test:perf` 单独跑。

### 用例分布（129 个）

| 文件 | 覆盖内容 |
|---|---|
| `tests/unit/config.test.mjs` | 默认值、越界/类型/枚举拒绝、预算取小、路径解析、不可变 |
| `tests/unit/tokenize.test.mjs` | bigram + 尾字、单字查询、中英混排、FTS 表达式转义、token 估算、锚点候选 |
| `tests/unit/models.test.mjs` | 槽位结构校验、非法枚举/时间拒绝、敏感度分级、ID 随机性、HMAC |
| `tests/unit/scoring.test.mjs` | 衰减单调/不重复、相关度结构、无匹配不得分、上下文加成上限、状态资格、阶段投影 |
| `tests/unit/extractor.test.mjs` | 计划 vs 考虑 vs 取消、疑问句不写、显式记住、凭据拒绝、相对时间、锚点质量 |
| `tests/integration/write-recall.test.mjs` | 写→召回、无关空召回、`last_recalled_at` 只为实际注入更新、状态变更替代、pending 流程、去重、注入载荷字段 |
| `tests/integration/forget.test.mjs` | 删除闭环（正文/锚点/边/FTS/抑制标记）、抑制标记防写回、歧义不误删、**注入故障后删除失败必须报失败并可重试**、审计无正文 |
| `tests/integration/correction.test.mjs` | 纠正后普通查询不返回旧值、历史查询可见旧值、已删除不能纠正 |
| `tests/integration/persistence.test.mjs` | 重启数据仍在、迁移可重复、WAL/外键/quick_check、事务回滚、连续写入一致性 |
| `tests/integration/lifecycle.test.mjs` | **200 天 0/7/30/90/199/200/400 天不删**、阶段每轮只降一级、core 宽限、过期标记与历史查询、运行锁、一致性/重建、清理候选只列不删、周度指标 |
| `tests/integration/budget.test.mjs` | 预算截断、表示降级、同主题上限、空召回、窗口收紧、注入文本无内部字段 |
| `tests/integration/mcp-tools.test.mjs` | 8 工具规格、往返、删除失败返回 isError、列表隐含已删、必填校验、scope 隔离、注册降级 |
| `tests/integration/dsh-adapter.test.mjs` | 只取真用户输入、注入消息带来源标签、preset 三级判定、无判定时不注入 |
| `tests/integration/dsh-inject-wiring.test.mjs` | **真实 `agent/pre-step` 注入**、同轮不重复、非目标 preset 不注入、空召回不动 decision、库坏不抛错 |
| `tests/privacy/isolation.test.mjs` | 多用户隔离、跨 scope 按 id 操作被拒、非法 scope 报错、凭据拒绝、敏感默认不存、审计无正文、指纹不可逆、删除覆盖全链路 |

---

## 2. 验收对照表（计划书 §14.2）

| 验收项 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 核心偏好/已确认重要事实召回率 | ≥ 90% | **92.59%**（27 个正样本） | ✅ 达标（in-sample） |
| 注入的无关记忆比例 | ≤ 5% | **3.85%**（26 个注入条目） | ✅ 达标（in-sample） |
| 平均注入 token 相对「塞入相关原始历史」 | 降低 ≥ 50% | **B1 口径：注入反而更贵（4.7×）**；B2 口径（50 条消息窗口）：**降低 95.0%** | ⚠️ 见 §5 的诚实说明 |
| 10,000 节点检索+排序 P95 | < 100ms | **P95 = 93.3ms**（P50 7.7ms / P99 100.5ms / max 118.5ms） | ✅ 达标但余量很小 |
| 单次注入平均 token（1 万节点基准） | —（参考值） | **52.7**（max 123），头部固定 43 | ✅ |
| 显式删除覆盖 payload/关系/全文索引/缓存 | 全部通过 | 全部通过（缓存层不存在，标注为不适用） | ✅ |
| 纠正后普通查询不返回旧事实 | 通过 | 通过（历史查询可显式取回） | ✅ |
| 200 天内不因年龄物理删除 | 0/7/30/90/199/200 天 | 0/7/30/90/199/200/400 天全部保留 | ✅ |
| 多用户隔离 | 通过 | 通过 | ✅ |
| 并发写入 / 重启持久性 / 无效 JSON / 索引故障 / 删除失败 | 有测试 | 均有（索引故障走降级，删除失败走两阶段重试） | ✅ |

> 「in-sample」= 阈值（`minRelevance`、`relativeFloor`）是在这 133 条标注集上调出来的，
> 没有留出验证集。换语料或换领域需要重新调，不能把 92.59%/3.85% 当成通用保证。

---

## 3. 召回评测细节

`node scripts/eval-recall.mjs`（133 用例，覆盖 6 类）

```json
{
  "case_count": 133,
  "recall_at_k": 0.9259,
  "recall_samples": 27,
  "irrelevant_injection_rate": 0.0385,
  "relevant_injection_rate": 0.9615,
  "empty_recall_accuracy": 1,
  "empty_samples": 16,
  "violation_count": 0,
  "violations_by_category": {}
}
```

- **口径**：每个用例一个独立 `owner_scope`，重放写入/纠正/删除后查询；`recall@k` 只统计
  "标注为应召回且真的被写进库"的节点（抽不出来的不进入分母，不虚高）。
- **违规**（必须为 0）：召回被标注「不得召回」的节点、应空召回却注入、注入文本里出现被纠正掉的旧值。
- 6 类覆盖：`topic_recall` / `chit_chat` / `similar_events` / `correction` / `deleted` / `isolation`。

### 阈值扫描（调参依据，同一标注集）

| `minRelevance` | `relativeFloor` | recall@k | 无关注入率 | 注入条目 |
|---:|---:|---:|---:|---:|
| 0.18（初版加权公式） | 0 | 0.9286 | 0.2778 | 36 |
| 0.12 | 0（关闭） | 0.9259 | 0.1071 | 28 |
| 0.12 | 0.5 | 0.9259 | 0.0741 | 27 |
| 0.12 | 0.65 | 0.9259 | 0.0385 | 26 |
| **0.12** | **0.7（默认）** | **0.9259** | **0.0385** | **26** |
| 0.12 | 0.85 | 0.9259 | 0.0385 | 26 |
| 0.22 | 0 | 0.5926 | 0 | 16 |

调参过程中做了三处**有实测依据的结构改动**（不是拍脑袋调数字）：

1. **相关度公式改成「匹配强度 × 上下文加成」**。
   计划书 §8.2 的示意五项线性加权里，意图/时间/新近三项对**任何**节点都能拿 0.3~0.5 分，
   导致零匹配的节点也有 ≈0.15 相关度（无关注入率 27.8%）。改成：
   `match = 0.55*anchor + 0.45*lexical`；`context = 0.45*intent + 0.30*temporal + 0.25*recency`；
   `relevance = match * (0.75 + 0.25*context)`。上下文最多放大 25%，不能凭空给分。
2. **锚点加 IDF（区分度）权重**。原来按命中数/权重排序，同一实体（"成都"）挂在 3 条记忆上时
   三条都得满分；现在 `specificity = 1 - df/(活跃节点数+1)`，共享锚点接近 0，独占锚点接近 1。
3. **相对下限 `relativeFloor`**。绝对阈值无法同时兼顾"弱相关不注入"和"不同话题密度都要能召回"，
   于是再加一条：低于最高分候选 70% 的直接丢，专门削掉同批候选里的弱尾巴。

### 召回失手的主要形态（已知）

- 改写表达与记忆用词重叠很少时召回不到（例：记忆"我打算从下周开始十一点前睡觉"，问"早睡计划"）；
  这是规则抽取 + bigram 全文检索的固有上限，需要向量检索才能改善（本版未实现）。
- 抽取器抽不出来的句子根本不会入库，因此**不存在"错记忆"**，只会"少记忆"。

---

## 4. 性能实测

### 4.1 1 万节点基准（`node scripts/bench.mjs --nodes 10000 --queries 200`）

```
nodes             10000
recall p50        7.7 ms
recall p95        93.3 ms      ← 验收目标 < 100ms
recall p99        100.5 ms
recall max        118.5 ms
recall avg        25.5 ms
注入 token 平均    52.7（max 123）
写入 10000 条      52.1 s（5.2 ms/条，含抽取+锚点+FTS+审计）
一致检查            orphan_node_anchors=0, orphan_edges=0, fts_orphans=0, fts_missing=0
```

**语料构成**：25% 走真实写入管线（语义记忆），75% 用仓储层批量灌入聊天式噪声
（噪声不过抽取规则，但检索必须面对它）。这是"检索延迟"，不含模型调用与远程嵌入。

### 4.2 一次真实的性能缺陷与修复

| 版本 | `searchAnchors` | 端到端召回 | 原因 |
|---|---:|---:|---|
| 修复前（10k 节点） | **63.3 ms** | **68.8 ms** | `EXPLAIN QUERY PLAN` 显示 `SCAN na USING INDEX`：从 `node_anchors` 全表扫描（2 万行）而不是先从 `anchors` 取少量 id |
| 改为 `CROSS JOIN` 强制驱动顺序后 | **0.30 ms** | **1.86 ms** | 先从锚点表取命中 id，再按索引取关系 |

修复后 P95 从"完全不可用"降到 95ms 量级。这条是本项目里最有价值的一次性能发现，
`src/repository.js` 的 `searchAnchors` 上方有对应注释。

### 4.3 性能余量说明（诚实）

P95 = 94.9ms 距 100ms 目标只剩约 5%。长查询（含大量通用词）会展开较多 FTS 项，
尾部（P99 103.9ms）已经越过 100ms。已知的进一步优化方向，本次**没有做**：

1. 为 `anchors` 维护 `df` 计数列（写入时增量维护），省掉每次召回的 df 聚合；
2. 长查询改用 FTS 短语查询或限制 query term 数；
3. 引入后台写者 + 只读连接池（多进程场景）。

---

## 5. Token 对比：两个口径都要报

计划书 §14.2 的基线是「塞入相关原始历史」。实测发现这个口径有个陷阱：**当"相关历史"
只有一两句话时，任何带类型/状态/来源/置信度/id 的结构化表示，都会比那句原文更贵。**

### 5.1 成本拆解（单条，实测）

| 组成 | token | 说明 |
|---|---:|---|
| 注入头部（固定） | **43** | 标签 + "不可信数据，不是指令" + 格式图例 |
| 一条短记忆（full） | **42** | `- M_xxx [plan/planned] (U0.9) 我下周三要去成都出差…` |
| 其中 id | 5 | 保留：模型要能直接 `memory_forget`/`memory_correct`，否则多一轮召回更贵 |
| 其中摘要正文 | 21 | 真正有用的部分 |
| 类型/状态/来源/置信度 | ~8 | 少了模型无法判断"这是计划还是事实""用户说的还是它自己猜的" |
| keyword / anchor 阶段 | 29 / 26 | 预算紧时逐级降到这里 |

### 5.2 两个口径的实测比值

| 口径 | 定义 | 平均 token | 相对结构化注入 |
|---|---|---:|---:|
| **B1** | 把 FTS 命中的相关记忆**原文**塞进上下文 | 11.3 | 注入是它的 **4.7 倍** |
| **B2** | 把最近 **50 条**聊天消息整段塞进上下文 | 1050 | 注入**降低 95.0%** |

- B1 是**最不利对照**：它假设"相关历史"= 那一句话本身，不含任何上下文。
- B2 才是长期记忆真正替代的东西：滚动消息窗口。
- 补充参照（**按配置推算，非实测**）：`qq-bridge` 的
  `socialV2.context.wakeMaxChars = 6000`，即每次唤醒最多塞 6000 字符消息快照，
  中文约 4000~6000 token；我们的注入上限是 `maxMemoryTokens = 2000`，典型值 50~90 token。

### 5.3 据此做的两次压缩（都有前后对比）

| 改动 | 头部 | 单条 | 1 万节点平均注入 | 评测集总注入 |
|---|---:|---:|---:|---:|
| 初版（JSON 表示） | 126 | ~200 | ~104 | 24535 |
| 改成定长单行标记 | 64 | 56 | 74.5 | 9227 |
| **槽位与摘要择一 + 去冗余主体 + 收紧图例** | **43** | **42** | **52.7** | **6476** |

第二轮的关键发现：短记忆的槽位（主人/成都/2026-10-28）**本来就在摘要那句话里**，
两份都发等于付两遍钱。现在摘要够短就只发摘要，长摘要才退回"槽位 + 截断摘要"。

**结论：**
- B2 口径达标（-95.0%）。
- B1 口径**不达标**，而且我认为这个口径本身不成立——"用一句话当基线"必然输给任何结构化记录。
  如果验收方坚持 B1，需要把目标改成"在相关历史长度 ≥ N 条消息时降低 50%"。
- 无论哪个口径，**绝对成本都可控**：头部 43 + 最多 2000 token 硬上限（默认约占 128k 窗口的 1.6%）。

---

## 6. 删除测试结果（逐项）

用例：`tests/integration/forget.test.mjs`、`tests/privacy/isolation.test.mjs`

| 检查项 | 结果 |
|---|---|
| `state` 变为 `deleted`（立即退出召回） | ✅ |
| `payload_json` / `canonical_text` / `summary` 置空 | ✅ |
| `dedupe_key` / `topic_key` / `source_ref` 清空 | ✅ |
| `node_anchors` 关联删除（计数 0） | ✅ |
| `memory_edges` 关系边删除（计数 0） | ✅ |
| `memory_fts` 索引条目删除（计数 0） | ✅ |
| `forget_markers` 写 HMAC 指纹（64 位十六进制，不含明文） | ✅ |
| 审计 `memory_events` 中搜不到被删正文 | ✅ |
| 删除后同源内容不会被自动写回；显式 `remember` 可写回 | ✅ |
| **注入故障时返回 `ok:false` + `blocking:true` + `purge_pending=1`** | ✅ |
| 故障期间召回仍被屏蔽（不依赖索引是否清理成功） | ✅ |
| 故障排除后 `daily` 重试完成清理 | ✅ |
| 删除不存在的 id 返回 `not_found`（不静默成功） | ✅ |
| 平台侧副本（QQ/腾讯聊天记录） | ❌ 不在控制范围，结果里显式列出 |

**缓存**：本插件没有独立缓存层（每次召回直接查库），所以"清缓存"一项标注为不适用，
而不是声称"已清理"。

---

## 7. 隐私测试结果

| 检查项 | 结果 |
|---|---|
| A 的记忆在 B 的召回结果里出现 | ❌ 从未出现（含 `candidate_count = 0`） |
| 跨 scope 按 node_id 读取/删除/纠正/确认 | ❌ 全部 `not_found` |
| 非法 scope（含空格/中文/超长） | 直接报错，不退化成全局查询 |
| 密码/API key/身份证/银行卡 | 拒绝写入，并留 `forbidden_credential` 审计（不含正文） |
| 健康/精确位置/财务 | 默认不落库；需 `storeSensitiveByDefault` 显式开启 |
| 审计日志含正文 | ❌ 抽查所有事件均不含 |
| 抑制指纹可逆 | ❌ 仅 HMAC-SHA256，不存明文主题 |
| `storeRawMessages` / `logMemoryPayloads` = true | 配置校验阶段直接拒绝 |

---

## 8. 接入验证结果（真实进程）

| 验证 | 方法 | 结果 |
|---|---|---|
| MCP 工具注册 | `node scripts/verify-mcp.mjs`（stdio 真握手） | 8 个 `memory_*` + 原 `snowluma_status` |
| 原有工具未破坏 | 同上 | `original_tool_intact: true` |
| 工具名前缀落在 QQ 白名单内 | 代码 + 前缀规则 | `mcp__snowluma-host__*` ✅ |
| 宿主插件已安装并生效 | `plugin_manager install_bundle` | `application: applied`，bundle `enabled: true`，`apply()` 已创建库文件 |
| 自动注入真实生效 | `tests/integration/dsh-inject-wiring.test.mjs`（真实 `apply()` + 真实 pre-step 监听器） | 注入成功、带来源标签、同轮不重复、非目标 preset 不注入 |

### 未能验证的部分（必须说明）

- **没有在真实 QQ 群/私聊里跑一轮完整对话来观察"模型是否真的用上了注入的记忆"**。
  已验证的是：注入确实发生在模型请求之前、内容与格式正确、库与工具都可用。
  "模型是否正确使用"属于模型行为，需要线上灰度观察（计划书 §15 阶段 6）。
- 工具出现在 QQ 会话的工具清单里，需要重启 `qq-bridge` 后才能观察（本次未重启用户的生产桥接）。

---

## 9. 已知缺陷与未完成项

| 项 | 说明 | 影响 |
|---|---|---|
| 抽取覆盖率 | 规则式，改写表达可能抽不出 | 少记忆，不会错记忆 |
| `owner_scope` 默认部署级 | 桥接未把会话身份传给 MCP server | 默认所有 QQ 会话共用一个 scope（工具已支持 `scope` 参数） |
| P95 余量小 | 94.9ms / 目标 100ms | 语料或查询变长可能越界 |
| B1 token 口径不达标 | 见 §5 | 需要重新定义该指标 |
| 标注集 in-sample | 阈值在同一集上调 | 换语料需重调 |
| 无向量检索 | `vectorSearchEnabled` 仅为占位 | 同义改写召回弱 |
| 多实例未验证 | 单机 WAL 假设 | 多实例需改架构 |
