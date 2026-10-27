-- QQ Agent 锚点记忆插件 —— 初始 schema（迁移 001）
--
-- 设计要点（对齐计划书 §5）：
--  1. tier / stage / state 是三个正交维度：tier=重要性层级，stage=注入表示精细度，
--     state=业务有效状态。删除用 state='deleted' + 清空正文，绝不用 stage 表示删除。
--  2. node_anchors 是节点↔锚点的**唯一权威**关联；不使用 JSON 数组做第二份权威数据。
--  3. memory_events 只保留排障所需元数据，禁止写入被删记忆正文。
--  4. 全文检索用自建 n-gram 列（toks），因为 SQLite 的 unicode61 与 trigram
--     都无法覆盖 1~2 字的中文查询（实测见 docs/ENV-REPORT.md）。
--  5. 所有表都带 owner_scope，任何查询都必须落在单一 scope 内。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_nodes (
  node_id               TEXT PRIMARY KEY,
  owner_scope           TEXT NOT NULL,
  payload_json          TEXT NULL,
  canonical_text        TEXT NULL,
  summary               TEXT NULL,
  memory_type           TEXT NOT NULL,
  tier                  TEXT NOT NULL,
  stage                 TEXT NOT NULL,
  state                 TEXT NOT NULL,
  extraction_confidence REAL NOT NULL DEFAULT 0,
  source_confidence     REAL NOT NULL DEFAULT 0,
  source_type           TEXT NOT NULL,
  source_ref            TEXT NULL,
  strength_base         REAL NOT NULL DEFAULT 1.0,
  strength_base_at      TEXT NOT NULL,
  last_recalled_at      TEXT NULL,
  last_confirmed_at     TEXT NULL,
  valid_from            TEXT NULL,
  valid_until           TEXT NULL,
  supersedes_node_id    TEXT NULL,
  sensitivity           TEXT NOT NULL DEFAULT 'normal',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT NULL,
  -- 1 = 正文已清空但仍有清理步骤未完成（关系/索引/标记），需要 maintenance 重试。
  purge_pending         INTEGER NOT NULL DEFAULT 0,
  -- 去重发现阶段的指纹（主题+类型+时间+规范化槽位），不是正文。
  dedupe_key            TEXT NULL,
  -- 主题指纹（不含时间）：用于发现"同一件事的新状态"，例如计划被取消。
  topic_key             TEXT NULL,
  CONSTRAINT ck_nodes_tier  CHECK (tier  IN ('core','normal','edge')),
  CONSTRAINT ck_nodes_stage CHECK (stage IN ('full','summary','keyword','anchor')),
  CONSTRAINT ck_nodes_state CHECK (state IN ('active','pending_confirm','superseded','cancelled','expired','deleted')),
  CONSTRAINT ck_nodes_source CHECK (source_type IN ('user_explicit','user_inferred','agent_generated','imported')),
  CONSTRAINT ck_nodes_sensitivity CHECK (sensitivity IN ('normal','sensitive','restricted')),
  CONSTRAINT ck_nodes_strength CHECK (strength_base >= 0.0 AND strength_base <= 1.0)
);

CREATE INDEX IF NOT EXISTS ix_nodes_scope_state_tier ON memory_nodes (owner_scope, state, tier);
CREATE INDEX IF NOT EXISTS ix_nodes_scope_type       ON memory_nodes (owner_scope, memory_type, state);
CREATE INDEX IF NOT EXISTS ix_nodes_last_recalled    ON memory_nodes (last_recalled_at);
CREATE INDEX IF NOT EXISTS ix_nodes_valid_until      ON memory_nodes (valid_until);
CREATE INDEX IF NOT EXISTS ix_nodes_stage            ON memory_nodes (stage, state);
CREATE INDEX IF NOT EXISTS ix_nodes_dedupe           ON memory_nodes (owner_scope, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_nodes_topic            ON memory_nodes (owner_scope, topic_key);
CREATE INDEX IF NOT EXISTS ix_nodes_purge_pending    ON memory_nodes (purge_pending) WHERE purge_pending = 1;

CREATE TABLE IF NOT EXISTS anchors (
  anchor_id        TEXT PRIMARY KEY,
  owner_scope      TEXT NOT NULL,
  normalized_token TEXT NOT NULL,
  display_token    TEXT NOT NULL,
  type             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL,
  last_hit_at      TEXT NULL,
  CONSTRAINT ck_anchors_type  CHECK (type IN ('topic','entity','action','time','slot')),
  CONSTRAINT ck_anchors_state CHECK (state IN ('active','blocked')),
  UNIQUE (owner_scope, normalized_token)
);

CREATE INDEX IF NOT EXISTS ix_anchors_scope_state ON anchors (owner_scope, state);

CREATE TABLE IF NOT EXISTS node_anchors (
  node_id      TEXT NOT NULL REFERENCES memory_nodes (node_id) ON DELETE CASCADE,
  anchor_id    TEXT NOT NULL REFERENCES anchors (anchor_id) ON DELETE CASCADE,
  owner_scope  TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  role         TEXT NOT NULL DEFAULT 'topic',
  PRIMARY KEY (node_id, anchor_id),
  CONSTRAINT ck_node_anchors_role CHECK (role IN ('subject','object','topic','time','action'))
);

CREATE INDEX IF NOT EXISTS ix_node_anchors_anchor ON node_anchors (anchor_id, owner_scope);

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id      TEXT PRIMARY KEY,
  owner_scope  TEXT NOT NULL,
  from_node_id TEXT NOT NULL REFERENCES memory_nodes (node_id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES memory_nodes (node_id) ON DELETE CASCADE,
  rel          TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CONSTRAINT ck_edges_rel CHECK (rel IN ('same_topic','previous_version','supersedes','depends_on','related_event')),
  UNIQUE (owner_scope, from_node_id, to_node_id, rel)
);

CREATE INDEX IF NOT EXISTS ix_edges_from ON memory_edges (from_node_id);
CREATE INDEX IF NOT EXISTS ix_edges_to   ON memory_edges (to_node_id);

-- 审计：只存排障元数据。detail_json 禁止写记忆正文/完整用户消息/密钥。
CREATE TABLE IF NOT EXISTS memory_events (
  event_id    TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  op          TEXT NOT NULL,
  target_id   TEXT NULL,
  result      TEXT NOT NULL,
  error_code  TEXT NULL,
  detail_json TEXT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_events_scope_time ON memory_events (owner_scope, created_at);
CREATE INDEX IF NOT EXISTS ix_events_op_result  ON memory_events (op, result);

-- 删除抑制标记：只存带密钥的 HMAC 指纹，避免"普通哈希 + 字典攻击还原正文"。
CREATE TABLE IF NOT EXISTS forget_markers (
  marker_id    TEXT PRIMARY KEY,
  owner_scope  TEXT NOT NULL,
  marker_kind  TEXT NOT NULL,
  marker_value TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (owner_scope, marker_kind, marker_value)
);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  run_id      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NULL,
  processed   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  error_code  TEXT NULL,
  detail_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS ix_runs_kind_time ON maintenance_runs (kind, started_at);

CREATE TABLE IF NOT EXISTS task_locks (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 全文索引：toks 为写入时生成的中文 bigram + ASCII token 串。
-- node_id 为 UNINDEXED 的外部键，删除时按 node_id 精确删除。
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  node_id UNINDEXED,
  toks,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS recall_stats (
  stat_id     TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       REAL NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_recall_stats ON recall_stats (kind, created_at);
