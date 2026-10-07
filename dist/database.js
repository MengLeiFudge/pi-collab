import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { databaseFilesystem } from "./paths.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { anchor, CollabError, newId, requireValue, uuid } from "./protocol.js";
import { dataDirectory } from "./signals.js";
import { createSchema, registerProtocol, schemaVersion } from "./schema.js";
export { schemaVersion } from "./schema.js";
/** 每条命令独占自己的连接；事务回调必须同步且短小。 */
export class Store {
    db;
    directory;
    path;
    warnings;
    /** 仅显式创建允许初始化；未知或丢失的已有库不得被静默替代。 */
    constructor(initialize = false) {
        this.directory = dataDirectory();
        this.path = join(this.directory, "collab.sqlite3");
        if (initialize)
            mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        requireValue(existsSync(this.directory), "NOT_INITIALIZED", "数据库尚未初始化；使用 open 的 create 显式创建任务");
        this.warnings = databaseFilesystem(this.directory);
        const present = existsSync(this.path);
        requireValue(present || initialize, "NOT_INITIALIZED", "数据库不存在，不能自动创建替代库");
        requireValue(present || readdirSync(this.directory).length === 0, "NOT_INITIALIZED", "数据目录非空，拒绝创建替代库；需要维护恢复");
        if (present)
            requireValue(!lstatSync(this.path).isSymbolicLink(), "FILESYSTEM", "数据库文件不能是符号链接");
        this.db = new DatabaseSync(this.path, { timeout: 3000 });
        try {
            registerProtocol(this.db);
            this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
            const version = this.one("PRAGMA user_version").user_version;
            if (version === 0 && initialize) {
                this.atomic(true, () => {
                    // 另一条初始化命令可能已完成；持有写锁后再次判断。
                    if (this.one("PRAGMA user_version").user_version !== 0)
                        return;
                    requireValue(this.one("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").count === 0, "SCHEMA", "拒绝初始化非空的未知数据库");
                    createSchema(this.db);
                });
            }
            this.checkSchema();
            if (process.platform !== "win32")
                chmodSync(this.path, 0o600);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    /** 每个事务入口确认库结构与本程序一致，未知版本直接拒绝。 */
    checkSchema() {
        const version = this.one("PRAGMA user_version").user_version;
        requireValue(version === schemaVersion, "SCHEMA", `不支持 schema ${version}，程序仅支持 ${schemaVersion}`);
    }
    /** 关闭本命令的连接，不影响其他客户端。 */
    close() { this.db.close(); }
    /** 单行查询中的类型由本模块固定 schema 与 SQL 列保证。 */
    one(sql, ...params) {
        return this.db.prepare(sql).get(...params);
    }
    /** 多行查询同样保持 SQL 绑定，不插值业务字段。 */
    all(sql, ...params) {
        return this.db.prepare(sql).all(...params);
    }
    /** 修改语句只接受 SQLite 可绑定值。 */
    run(sql, ...params) { this.db.prepare(sql).run(...params); }
    /** BEGIN IMMEDIATE 让检查门禁和写入形成同一串行边界。 */
    atomic(write, action) {
        this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
            const result = action();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /** 元数据与业务读取必须使用同一事务快照。 */
    metadata() { return this.one("SELECT * FROM metadata WHERE singleton=1"); }
    /** 元数据保存当前维护者及可核对的操作阶段。 */
    maintenance() {
        const value = this.metadata().maintenance;
        return value ? JSON.parse(value) : null;
    }
    /** 业务事务不能绕过维护标记；维护者必须匹配操作 UUID。 */
    gate(owner) {
        this.checkSchema();
        const meta = this.metadata();
        const gate = meta.maintenance ? JSON.parse(meta.maintenance) : null;
        requireValue(owner === undefined ? !gate : gate?.id === owner, "MAINTENANCE", "数据库维护中；进程退出后使用 maintain recover 核对恢复", { maintenance: gate });
        return meta;
    }
    /** 按稳定 UUID 定位数据库房间。 */
    task(id) {
        const task = this.one("SELECT * FROM tasks WHERE id=?", id);
        requireValue(task, "NOT_FOUND", "任务不存在", { task_id: id });
        return task;
    }
    /** 已删除或复用的序号不会被误当作同一条历史。 */
    checkAnchor(task, value) {
        const point = anchor(value);
        const event = point.seq ? this.one("SELECT id FROM events WHERE task_id=? AND seq=?", task.id, point.seq) : undefined;
        if (point.seq > task.event_seq || (point.seq && event?.id !== point.event_id)) {
            throw new CollabError("HISTORY_DIVERGED", "任务历史倒退或分歧，请核对当前合同后从零重新同步", {
                observed_sequence_gap: Math.max(0, point.seq - task.event_seq), current_seq: task.event_seq, after: point,
            });
        }
        return point;
    }
    /** 世代和调用方锚点校验在数据操作的事务内完成。 */
    guard(request, task, writing) {
        const meta = this.gate();
        if (request.database_id !== undefined)
            requireValue(uuid(request.database_id, "database_id") === meta.database_id, "DATABASE_CHANGED", "数据库身份不匹配");
        if (writing || request.generation !== undefined) {
            requireValue(uuid(request.generation, "generation") === meta.generation, "GENERATION_CHANGED", "数据库已恢复；重新同步后再决定是否重试", { generation: meta.generation });
        }
        this.checkAnchor(task, request.after);
        return meta;
    }
    /** 每个事件消耗任务内一个安全整数序号，UUID 保证跨恢复身份唯一。 */
    event(task, kind, objectId, summary, author) {
        requireValue(task.event_seq < Number.MAX_SAFE_INTEGER, "SEQUENCE_LIMIT", "任务事件序号已达安全整数上限");
        const seq = task.event_seq + 1;
        const id = newId();
        this.run("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", id, task.id, seq, kind, objectId, summary, author, new Date().toISOString());
        this.run("UPDATE tasks SET event_seq=? WHERE id=?", seq, task.id);
        task.event_seq = seq;
        return { seq, event_id: id };
    }
}
