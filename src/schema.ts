import type { DatabaseSync } from "node:sqlite";
import { newId, requireValue } from "./protocol.ts";

/** 群聊持久化版本；业务连接与备份恢复只接受此版本。 */
export const schemaVersion = 2;

/** 空库一次性建立完整结构，房间与首版合同在业务事务中创建。 */
const initialSchema = `
CREATE TABLE metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  database_id TEXT NOT NULL, generation TEXT NOT NULL,
  maintenance TEXT, last_backup_attempt INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE projects (id TEXT PRIMARY KEY, locator TEXT NOT NULL UNIQUE, git TEXT, root TEXT NOT NULL) STRICT;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  current_revision TEXT NOT NULL, event_seq INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL, event_seq INTEGER NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(task_id, version)
) STRICT;
CREATE TABLE members (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL COLLATE BINARY, model TEXT NOT NULL,
  owner_client TEXT, owner_session TEXT, lease TEXT, claimed_generation TEXT,
  joined_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  urgent_enabled INTEGER NOT NULL DEFAULT 1 CHECK(urgent_enabled IN (0,1)),
  duty TEXT NOT NULL DEFAULT '', duty_revision TEXT,
  UNIQUE(task_id,name),
  CHECK ((owner_client IS NULL AND owner_session IS NULL AND lease IS NULL AND claimed_generation IS NULL)
    OR (owner_client IS NOT NULL AND owner_session IS NOT NULL AND lease IS NOT NULL AND claimed_generation IS NOT NULL))
) STRICT;
CREATE TABLE messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN ('message','issue')),
  body TEXT NOT NULL, summary TEXT NOT NULL, author TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id), evidence TEXT NOT NULL,
  event_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
  chat_no INTEGER NOT NULL CHECK(chat_no > 0),
  member_id TEXT NOT NULL REFERENCES members(id),
  reply_revision TEXT REFERENCES revisions(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent')),
  reason TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '"all"' CHECK(json_valid(audience)),
  CHECK (reply_to IS NULL OR reply_revision IS NULL)
) STRICT;
CREATE TABLE issues (
  id TEXT PRIMARY KEY REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('open','addressed','rejected')),
  revision_id TEXT NOT NULL, version INTEGER NOT NULL,
  resolution_id TEXT REFERENCES messages(id), updated_seq INTEGER NOT NULL
) STRICT;
CREATE TABLE events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL,
  kind TEXT NOT NULL, object_id TEXT NOT NULL, summary TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, seq)
) STRICT;
CREATE TABLE requests (
  task_id TEXT NOT NULL REFERENCES tasks(id), generation TEXT NOT NULL,
  client TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(task_id, generation, client, session_id, request_id)
) STRICT;
CREATE TABLE member_views (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  generation TEXT NOT NULL, query TEXT NOT NULL, messages TEXT NOT NULL, queried_at TEXT NOT NULL
) STRICT;
CREATE TABLE progress_revisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
  event_seq INTEGER NOT NULL, contract_revision TEXT NOT NULL REFERENCES revisions(id),
  state TEXT NOT NULL CHECK(json_valid(state)), author TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(task_id,version)
) STRICT;
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation TEXT NOT NULL,
  client TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(json_valid(plan)), state TEXT NOT NULL CHECK(state IN ('prepared','registered')),
  objects TEXT CHECK(objects IS NULL OR json_valid(objects)), author TEXT NOT NULL, event_seq INTEGER, created_at TEXT NOT NULL,
  UNIQUE(task_id,generation,client,session_id,request_id),
  CHECK ((state='prepared' AND objects IS NULL AND event_seq IS NULL)
    OR (state='registered' AND objects IS NOT NULL AND event_seq IS NOT NULL))
) STRICT;
CREATE TABLE assignments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), member_id TEXT NOT NULL REFERENCES members(id),
  current_revision TEXT NOT NULL,
  conflict_paths TEXT CHECK(conflict_paths IS NULL OR json_valid(conflict_paths))
) STRICT;
CREATE TABLE assignment_revisions (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id), version INTEGER NOT NULL,
  workspace TEXT NOT NULL, scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  state TEXT NOT NULL CHECK(state IN ('active','release-pending','released')),
  stage TEXT NOT NULL, deliverable TEXT NOT NULL, contract_revision TEXT NOT NULL REFERENCES revisions(id),
  basis TEXT NOT NULL, blocked TEXT NOT NULL, lease TEXT NOT NULL, stopped INTEGER NOT NULL CHECK(stopped IN (0,1)),
  author TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, event_seq INTEGER NOT NULL,
  UNIQUE(assignment_id,version)
) STRICT;
CREATE TABLE creation_requests (
  generation TEXT NOT NULL, client TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), created INTEGER NOT NULL CHECK(created IN (0,1)),
  PRIMARY KEY(generation,client,session_id,request_id)
) STRICT;
CREATE INDEX open_issues ON issues(task_id, state, id);
CREATE INDEX revision_sequence ON revisions(task_id, event_seq);
CREATE UNIQUE INDEX chat_sequence ON messages(task_id,chat_no);
CREATE INDEX member_messages ON messages(task_id,member_id,chat_no);
CREATE INDEX progress_sequence ON progress_revisions(task_id,event_seq);
CREATE INDEX snapshot_sequence ON snapshots(task_id,event_seq);
CREATE INDEX assignment_owner ON assignments(task_id,member_id);
`;

/** 每个可写连接注册固定协议，写触发器拒绝不匹配的连接。 */
export function registerProtocol(db: DatabaseSync): void {
  // 库和 schema 由本工具维护；Node 尚不提供 innocuous 标记，触发器需明确允许此函数。
  db.exec("PRAGMA trusted_schema=ON");
  db.function("collab_protocol", { deterministic: true }, () => schemaVersion);
}

/** 初始化只用于明确创建的空库；调用方负责检查库为空并持有写事务。 */
export function createSchema(db: DatabaseSync): void {
  requireValue(db.isTransaction, "SCHEMA", "初始化 schema 必须在写事务内执行");
  db.exec(initialSchema);
  db.prepare("INSERT INTO metadata(singleton,database_id,generation) VALUES(1,?,?)").run(newId(), newId());
  upgradeSchema(db);
}

/** 为新库及公开 schema 1 升级追加桥接结构；调用者负责门禁和备份。 */
export function upgradeSchema(db: DatabaseSync): void {
  requireValue(db.isTransaction, "SCHEMA", "升级必须在写事务内执行");
  db.exec(`
    ALTER TABLE members ADD COLUMN kind TEXT NOT NULL DEFAULT 'pi' CHECK(kind IN ('pi','external'));
    CREATE TABLE bridge_batches (
      id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
      generation TEXT NOT NULL, group_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE bridge_sources (
      bridge_id TEXT NOT NULL, platform_id TEXT NOT NULL, group_id TEXT NOT NULL, message_id TEXT NOT NULL,
      batch_id TEXT NOT NULL REFERENCES bridge_batches(id), sender_id TEXT NOT NULL,
      received_at INTEGER NOT NULL, body TEXT,
      PRIMARY KEY(bridge_id,platform_id,group_id,message_id)
    ) STRICT;
    CREATE TABLE bridge_decisions (
      id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
      generation TEXT NOT NULL, contract_revision TEXT NOT NULL REFERENCES revisions(id),
      batch_id TEXT NOT NULL REFERENCES bridge_batches(id), member_id TEXT NOT NULL REFERENCES members(id),
      question TEXT NOT NULL, options TEXT NOT NULL, content_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','answered','cancelled')),
      reply TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE bridge_outbox (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, bridge_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id), generation TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('decision','conclusion')), target TEXT NOT NULL,
      body TEXT NOT NULL, decision_id TEXT REFERENCES bridge_decisions(id),
      acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0,1)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE bridge_requests (
      bridge_id TEXT NOT NULL, generation TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(bridge_id,generation,request_id)
    ) STRICT;
    CREATE INDEX bridge_raw_expiry ON bridge_sources(received_at) WHERE body IS NOT NULL;
    CREATE INDEX bridge_pending ON bridge_outbox(bridge_id,generation,acked,seq);
  `);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name: table } of tables) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`DROP TRIGGER IF EXISTS protocol_${table}_${operation.toLowerCase()};
CREATE TRIGGER protocol_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
BEGIN SELECT CASE WHEN collab_protocol() != ${schemaVersion} THEN RAISE(ABORT,'COLLAB_PROTOCOL') END; END;`);
    }
  }
  db.exec(`PRAGMA user_version=${schemaVersion}`);
}
