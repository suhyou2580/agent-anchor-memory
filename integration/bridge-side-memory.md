# 桥接侧记忆（qq-bridge）与插件的配合

`qq-bridge` 本身带一套"原文型"记忆，和锚点记忆是**互补**关系，不要二选一。

## 桥接侧有什么

| 能力 | 存储 | 写入工具 | 读取方式 | 注入时机 |
|---|---|---|---|---|
| 口味库 | `state/taste.json` | `qq_taste_add` / `qq_taste_list` | 每轮注入"她自己的口味" | 每轮 |
| 日记 | `diary/YYYY-MM-DD.md` | `qq_diary_write` / `qq_diary_read` | 每轮注入最近两天（截断 300 字） | 每轮 |
| 世界观 | `state/worldview.md` | `qq_worldview` | 每轮注入全文（≤800 字） | 每轮 |
| 记忆归档 | `memories/<会话>-<时间>.md` | 桥接自动（上下文到阈值，默认 70%/15%） | `qq_recall_memory` 关键词检索 | 按需 |
| 轻量记忆 | `state/social-v2.json` 里 | `qq_memory_append` 等 | 每轮注入 | 每轮 |

## 归档的结构（`memories/*.md`）

桥接在上下文达到阈值时自动生成，按"挑着留"组织：

```markdown
# 记忆归档 · private:2077884862
- 归档时间 / 上下文占比 / 触发条件

## 她是谁（别忘）         ← 角色一句话
### 她自己记下的喜好      ← 来自 taste.json
### 她自己写下的看法      ← 来自 worldview.md

## 爸爸提醒过的事（答应过的） ← 主人消息里带"记住/以后/不要/必须"的句子
## 我们之间的日常（当时的心境） ← 挑有情绪的句子，带时间戳
## 她记着的人与话题        ← 轻量记忆
## 最近对话（摘要）        ← 最后 30 条
```

**注意**：归档之后桥接会**换一个新上下文**（省 token）。所以归档就是"换新前的那张快照"。

## 和插件的分工

| 场景 | 用哪个 |
|---|---|
| "你还记得那天我说了什么吗"（原话） | 桥接归档 `qq_recall_memory` |
| "我讨厌吃什么""我要去哪""我答应过什么"（事实） | 锚点记忆 `memory_recall` |
| "她最近喜欢什么""她在想什么" | 口味库 / 日记（每轮自动注入） |

## 一次性搬迁

把桥接侧已有的记忆搬进锚点库：

```powershell
node scripts/import-existing-memory.mjs
# 或指定桥接目录
QQ_BRIDGE_DIR=D:/qq-bridge node scripts/import-existing-memory.mjs
```

它会把 taste.json、diary、worldview、memories 里的关键句**改写成抽取器认得的句式**再写入，
所以能保证 FTS 索引、锚点、去重键都正确生成（直接插 SQL 会漏掉这些，检索就废了）。

搬完建议跑一次：

```powershell
node scripts/confirm-pending.mjs --apply   # 确认那些落在 pending_confirm 的条目
```

## 换新上下文后她还记得什么

```
角色卡（永久） + 口味/日记/世界观（每轮注入）+ 锚点记忆（每轮召回）+ 归档（按需查）
```

这就是"上下文可以放心养小"的原因：记忆外置了，不靠窗口续命。
