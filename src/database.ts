import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { databaseFilesystem } from "./paths.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { anchor, CollabError, newId, requireValue, uuid } from "./protocol.ts";
import type { Anchor, Request } from "./protocol.ts";
import { dataDirectory } from "./signals.ts";

import { createSchema, registerProtocol, schemaVersion } from "./schema.ts";
export { schemaVersion } from "./schema.ts";

/** 门禁在业务事务中检查；恢复源保护随未解决的维护操作保留。 */
export interface Maintenance {
  id: string;
  kind: "backup" | "restore";
  pid: number;
  process_start: string;
  started_at: string;
  phase: string;
  source_backup?: string;
  old_generation?: string;
  new_generation?: string;
}

/** 数据库身份不会随恢复变化；世代会变化。 */
export interface Metadata {
  database_id: string;
  generation: string;
  maintenance: string | null;
  last_backup_attempt: number;
}

/** 当前任务指针；正文与状态位于不可变版本行中。 */
export interface Task {
  id: string;
  project_id: string;
  current_revision: string;
  event_seq: number;
}

/** 不可变文档版本包含该时刻的完整任务合同。 */
export interface Revision {
  id: string;
  task_id: string;
  version: number;
  event_seq: number;
  title: string;
  summary: string;
  status: string;
  body: string;
  author: string;
  created_at: string;
}


/** 每条命令独占自己的连接；事务回调必须同步且短小。 */
export class Store {
  db: DatabaseSync;
  directory: string;
  path: string;
  readonly warnings: string[];

  /** 仅显式创建允许初始化；未知或丢失的已有库不得被静默替代。 */
  constructor(initialize = false) {
    this.directory = dataDirectory();
    this.path = join(this.directory, "collab.sqlite3");
    if (initialize) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    requireValue(existsSync(this.directory), "NOT_INITIALIZED", "数据库尚未初始化；使用 open 的 create 显式创建任务");
    this.warnings = databaseFilesystem(this.directory);
    const present = existsSync(this.path);
    requireValue(present || initialize, "NOT_INITIALIZED", "数据库不存在，不能自动创建替代库");
    requireValue(present || readdirSync(this.directory).length === 0, "NOT_INITIALIZED", "数据目录非空，拒绝创建替代库；需要维护恢复");
    if (present) requireValue(!lstatSync(this.path).isSymbolicLink(), "FILESYSTEM", "数据库文件不能是符号链接");
    this.db = new DatabaseSync(this.path, { timeout: 3000 });
    try {
      registerProtocol(this.db);
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      const version = this.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
      if (version === 0 && initialize) {
        this.atomic(true, () => {
          // 另一条初始化命令可能已完成；持有写锁后再次判断。
          if (this.one<{ user_version: number }>("PRAGMA user_version")!.user_version !== 0) return;
          requireValue(this.one<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")!.count === 0,
            "SCHEMA", "拒绝初始化非空的未知数据库");
          createSchema(this.db);
        });
      }
      this.checkSchema();
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** 每个事务入口确认库结构与本程序一致，未知版本直接拒绝。 */
  checkSchema(): void {
    const version = this.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
    requireValue(version === schemaVersion, "SCHEMA", `不支持 schema ${version}，程序仅支持 ${schemaVersion}`);
  }

  /** 关闭本命令的连接，不影响其他客户端。 */
  close(): void { this.db.close(); }

  /** 单行查询中的类型由本模块固定 schema 与 SQL 列保证。 */
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** 多行查询同样保持 SQL 绑定，不插值业务字段。 */
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** 修改语句只接受 SQLite 可绑定值。 */
  run(sql: string, ...params: SQLInputValue[]): void { this.db.prepare(sql).run(...params); }

  /** BEGIN IMMEDIATE 让检查门禁和写入形成同一串行边界。 */
  atomic<T>(write: boolean, action: () => T): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 元数据与业务读取必须使用同一事务快照。 */
  metadata(): Metadata { return this.one<Metadata>("SELECT * FROM metadata WHERE singleton=1")!; }

  /** 元数据保存当前维护者及可核对的操作阶段。 */
  maintenance(): Maintenance | null {
    const value = this.metadata().maintenance;
    return value ? JSON.parse(value) as Maintenance : null;
  }

  /** 业务事务不能绕过维护标记；维护者必须匹配操作 UUID。 */
  gate(owner?: string): Metadata {
    this.checkSchema();
    const meta = this.metadata();
    const gate = meta.maintenance ? JSON.parse(meta.maintenance) as Maintenance : null;
    requireValue(owner === undefined ? !gate : gate?.id === owner, "MAINTENANCE", "数据库维护中；进程退出后使用 maintain recover 核对恢复", { maintenance: gate });
    return meta;
  }

  /** 按稳定 UUID 定位数据库房间。 */
  task(id: string): Task {
    const task = this.one<Task>("SELECT * FROM tasks WHERE id=?", id);
    requireValue(task, "NOT_FOUND", "任务不存在", { task_id: id });
    return task;
  }

  /** 已删除或复用的序号不会被误当作同一条历史。 */
  checkAnchor(task: Task, value: unknown): Anchor {
    const point = anchor(value);
    const event = point.seq ? this.one<{ id: string }>("SELECT id FROM events WHERE task_id=? AND seq=?", task.id, point.seq) : undefined;
    if (point.seq > task.event_seq || (point.seq && event?.id !== point.event_id)) {
      throw new CollabError("HISTORY_DIVERGED", "任务历史倒退或分歧，请核对当前合同后从零重新同步", {
        observed_sequence_gap: Math.max(0, point.seq - task.event_seq), current_seq: task.event_seq, after: point,
      });
    }
    return point;
  }

  /** 世代和调用方锚点校验在数据操作的事务内完成。 */
  guard(request: Request, task: Task, writing: boolean): Metadata {
    const meta = this.gate();
    if (request.database_id !== undefined) requireValue(uuid(request.database_id, "database_id") === meta.database_id, "DATABASE_CHANGED", "数据库身份不匹配");
    if (writing || request.generation !== undefined) {
      requireValue(uuid(request.generation, "generation") === meta.generation, "GENERATION_CHANGED", "数据库已恢复；重新同步后再决定是否重试", { generation: meta.generation });
    }
    this.checkAnchor(task, request.after);
    return meta;
  }

  /** 每个事件消耗任务内一个安全整数序号，UUID 保证跨恢复身份唯一。 */
  event(task: Task, kind: string, objectId: string, summary: string, author: string): Anchor {
    requireValue(task.event_seq < Number.MAX_SAFE_INTEGER, "SEQUENCE_LIMIT", "任务事件序号已达安全整数上限");
    const seq = task.event_seq + 1;
    const id = newId();
    this.run("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", id, task.id, seq, kind, objectId, summary, author, new Date().toISOString());
    this.run("UPDATE tasks SET event_seq=? WHERE id=?", seq, task.id);
    task.event_seq = seq;
    return { seq, event_id: id };
  }
}
