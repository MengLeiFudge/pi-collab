import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Store, schemaVersion } from "./database.ts";
import type { Maintenance, Metadata } from "./database.ts";
import { atomicFile } from "./routing.ts";
import { choice, CollabError, newId, requireValue, uuid } from "./protocol.ts";
import type { Request } from "./protocol.ts";
import { registerProtocol } from "./schema.ts";
import { processGone, processIdentity } from "./processes.ts";

/** 外部备份目录在数据库恢复后仍保留完整的副本清单。 */
interface BackupRecord {
  format: 1;
  id: string;
  created_at: string;
  purpose: "routine" | "manual" | "before-restore";
  database_id: string;
  generation: string;
  schema_version: number;
  page_size: number;
  contains_maintenance: boolean;
}


/** 设置门禁时与先前业务写事务串行，所有后续写事务都能看到标记。 */
function acquire(store: Store): Maintenance {
  return store.atomic(true, () => {
    store.gate();
    const gate: Maintenance = {
      id: newId(), kind: "backup", pid: process.pid, process_start: processIdentity(process.pid)!,
      started_at: new Date().toISOString(), phase: "acquired",
    };
    store.run("UPDATE metadata SET maintenance=? WHERE singleton=1", JSON.stringify(gate));
    return gate;
  });
}

/** 阶段信息随门禁保存，进程中断后不能只依靠时间猜测结果。 */
function advance(store: Store, gate: Maintenance, phase: string): void {
  store.atomic(true, () => {
    store.gate(gate.id);
    gate.phase = phase;
    store.run("UPDATE metadata SET maintenance=? WHERE singleton=1", JSON.stringify(gate));
  });
}

/** 仅当前维护所有者可以解除门禁和恢复源保护。 */
function release(store: Store, gate: Maintenance): void {
  store.atomic(true, () => {
    store.gate(gate.id);
    store.run("UPDATE metadata SET maintenance=NULL WHERE singleton=1");
  });
}

/** 原维护进程已退出或本次连接已关闭后，只回收对应门禁的生成副本。 */
function cleanStaging(store: Store, gate: Maintenance): string[] {
  const warnings: string[] = [];
  try {
    const path = join(store.directory, `restore-${uuid(gate.id, "maintenance.id")}.sqlite3`);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try { unlinkSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`恢复副本回收失败 ${file}：${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) { warnings.push(`无法定位恢复副本：${error instanceof Error ? error.message : error}`); }
  return warnings;
}

/** 仅用于已证明没有写回的受控失败；释放失败仍保留可核对门禁。 */
function abandon(store: Store, gate: Maintenance, cause: unknown): never {
  try { release(store, gate); }
  catch (error) {
    throw new CollabError("MAINTENANCE", `维护失败且门禁未能释放：${String(cause)}；${String(error)}`, { maintenance_id: gate.id });
  }
  const warnings = gate.kind === "restore" ? cleanStaging(store, gate) : [];
  if (warnings.length) throw new CollabError("MAINTENANCE_FAILED", String(cause), { warnings });
  throw cause;
}

/** 只盘点程序格式的备份；损坏清单不能静默视为没有备份。 */
function catalog(store: Store): BackupRecord[] {
  const directory = join(store.directory, "backups");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => {
    const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as BackupRecord;
    requireValue(record.format === 1 && uuid(record.id, "backup_id") + ".json" === name &&
      typeof record.created_at === "string" && Number.isFinite(Date.parse(record.created_at)), "BACKUP", `无效备份清单：${name}`);
    requireValue(existsSync(join(directory, `${record.id}.sqlite3`)), "BACKUP", `备份文件缺失：${record.id}`);
    return record;
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/** 备份检查通过 SQLite 读取完整数据库，不把 WAL 外的裸主文件当副本。 */
function inspect(path: string): Omit<BackupRecord, "format" | "id" | "created_at" | "purpose"> {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 3000 });
  try {
    const checked = db.prepare("PRAGMA quick_check").all();
    requireValue(checked.length === 1 && checked[0].quick_check === "ok", "BACKUP", "备份完整性检查失败");
    const meta = db.prepare("SELECT * FROM metadata WHERE singleton=1").get() as unknown as Metadata;
    return {
      database_id: uuid(meta.database_id, "database_id"), generation: uuid(meta.generation, "generation"),
      schema_version: Number(db.prepare("PRAGMA user_version").get()!.user_version),
      page_size: Number(db.prepare("PRAGMA page_size").get()!.page_size), contains_maintenance: meta.maintenance !== null,
    };
  } finally { db.close(); }
}

/** 轮换在写事务内串行；七个普通槽位之外保留当前恢复源。 */
function rotate(store: Store, owner?: string): void {
  store.atomic(true, () => {
    const gate = store.maintenance();
    // 普通备份可能在维护门禁设置前开始；它不能干预该维护的保留集合。
    if (gate && gate.id !== owner) return;
    const records = catalog(store);
    const protectedIds = new Set<string>();
    if (gate?.source_backup) protectedIds.add(gate.source_backup);
    let slots = 0;
    for (const record of records) {
      if (protectedIds.has(record.id)) continue;
      if (++slots <= 7) continue;
      // 只轮换本程序已登记的生成副本；先移除登记，残留文件不会被用作有效备份。
      unlinkSync(join(store.directory, "backups", `${record.id}.json`));
      unlinkSync(join(store.directory, "backups", `${record.id}.sqlite3`));
    }
  });
}

/** VACUUM INTO 必须在事务外执行；元数据仅在完整副本形成后登记。 */
function createBackup(store: Store, purpose: BackupRecord["purpose"], owner?: string): BackupRecord {
  const directory = join(store.directory, "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = newId();
  const target = join(directory, `${id}.sqlite3`);
  store.db.prepare("VACUUM INTO ?").run(target);
  const record: BackupRecord = { format: 1, id, purpose, created_at: new Date().toISOString(), ...inspect(target) };
  atomicFile(join(directory, `${id}.json`), JSON.stringify(record, null, 2) + "\n");
  rotate(store, owner);
  return record;
}

/** 例行备份失败仅成为结果告警，尝试间隔防止每次写入反复遇到同一错误。 */
export function routineBackup(store: Store): string[] {
  try {
    const attempt = store.atomic(true, () => {
      if (store.maintenance()) return false;
      const now = Date.now();
      if (now - store.metadata().last_backup_attempt < 300_000) return false;
      store.run("UPDATE metadata SET last_backup_attempt=? WHERE singleton=1", now);
      return true;
    });
    if (attempt) {
      // 先提交尝试时间，清单读取失败也遵守退避间隔。
      const recent = catalog(store)[0];
      if (!recent || Date.now() - Date.parse(recent.created_at) >= 86_400_000) createBackup(store, "routine");
    }
    return [];
  } catch (error) {
    return [`例行备份失败，业务写入已提交：${error instanceof Error ? error.message : error}`];
  }
}

/** 接管只允许已退出的进程；活进程即使超过期限也不能被抢占。 */
function takeOver(store: Store): Maintenance {
  return store.atomic(true, () => {
    const gate = store.maintenance();
    requireValue(gate, "MAINTENANCE", "没有待恢复的维护操作");
    requireValue(processGone(gate.pid, gate.process_start), "MAINTENANCE", "维护进程仍可能运行或无法确认退出，不能接管", { maintenance: gate });
    gate.pid = process.pid;
    gate.process_start = processIdentity(process.pid)!;
    store.run("UPDATE metadata SET maintenance=? WHERE singleton=1", JSON.stringify(gate));
    return gate;
  });
}

/** 恢复目标仍是原 SQLite 文件；新门禁与世代从恢复副本一并提交。 */
async function restore(store: Store, request: Request): Promise<Record<string, unknown>> {
  const sourceId = uuid(request.backup_id, "backup_id");
  // 选择与 pin 在同一写事务内，轮换不能在两者之间删除恢复源。
  const gate = store.atomic(true, () => {
    store.gate();
    const record = catalog(store).find(item => item.id === sourceId);
    requireValue(record, "BACKUP", "恢复源不存在");
    const meta = store.metadata();
    requireValue(record.database_id === meta.database_id && record.schema_version === schemaVersion, "BACKUP", "备份身份或 schema 不匹配");
    const value: Maintenance = {
      id: newId(), kind: "restore", pid: process.pid, process_start: processIdentity(process.pid)!, started_at: new Date().toISOString(),
      phase: "source-pinned", source_backup: sourceId, old_generation: meta.generation, new_generation: newId(),
    };
    store.run("UPDATE metadata SET maintenance=? WHERE singleton=1", JSON.stringify(value));
    return value;
  });
  let copying = false;
  let source: DatabaseSync | undefined;
  let staging: DatabaseSync | undefined;
  try {
    const sourcePath = join(store.directory, "backups", `${sourceId}.sqlite3`);
    const info = inspect(sourcePath);
    requireValue(info.database_id === store.metadata().database_id && info.schema_version === schemaVersion &&
      info.page_size === store.one<{ page_size: number }>("PRAGMA page_size")!.page_size, "BACKUP", "恢复源实际身份、schema 或页大小不匹配");
    createBackup(store, "before-restore", gate.id);
    const stagingPath = join(store.directory, `restore-${gate.id}.sqlite3`);
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 3000 });
    try { source.prepare("VACUUM INTO ?").run(stagingPath); } finally { source.close(); source = undefined; }
    staging = new DatabaseSync(stagingPath, { timeout: 3000 });
    try {
      registerProtocol(staging);
      staging.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        gate.phase = "restored";
        staging.prepare("UPDATE metadata SET generation=?,maintenance=?,last_backup_attempt=0 WHERE singleton=1")
          .run(gate.new_generation!, JSON.stringify(gate));
        staging.prepare("UPDATE members SET owner_client=NULL,owner_session=NULL,lease=NULL,claimed_generation=NULL").run();
        staging.exec("COMMIT");
      } catch (error) { staging.exec("ROLLBACK"); throw error; }
      const prepared = inspect(stagingPath);
      requireValue(prepared.schema_version === schemaVersion && prepared.generation === gate.new_generation &&
        prepared.database_id === info.database_id && prepared.contains_maintenance, "RESTORE", "恢复副本核对失败");
      advance(store, gate, "copying");
      copying = true;
      // 写回开始后的失败可能已提交，必须保留门禁让 recover 核对世代。
      await backup(staging, store.path);
    } finally { staging.close(); staging = undefined; }
    const checked = inspect(store.path);
    requireValue(checked.generation === gate.new_generation && checked.database_id === info.database_id &&
      checked.schema_version === schemaVersion && checked.page_size === info.page_size && checked.contains_maintenance, "RESTORE", "恢复后身份、schema、页大小或门禁核对失败");
    release(store, gate);
    return { restored: true, source_backup: sourceId, generation: checked.generation, database_id: checked.database_id, warnings: cleanStaging(store, gate) };
  } catch (error) {
    // close 抛错时仍可能持有副本连接，保留到进程退出后由 recover 回收。
    if (!copying && !source && !staging) abandon(store, gate, error);
    throw error;
  }
}

/** 崩溃后的恢复核对已提交 schema 和世代，不凭进程退出推断操作成功。 */
function recover(store: Store): Record<string, unknown> {
  const gate = takeOver(store);
  let restored = false;
  if (gate.kind === "restore") {
    const checked = inspect(store.path);
    requireValue(checked.schema_version === schemaVersion && (checked.generation === gate.old_generation ||
      checked.generation === gate.new_generation), "RESTORE", "恢复结果 schema 或世代未知，保留门禁");
    restored = checked.generation === gate.new_generation;
  }
  release(store, gate);
  return { recovered_operation: gate.id, kind: gate.kind, restored, generation: store.metadata().generation,
    warnings: gate.kind === "restore" ? cleanStaging(store, gate) : [] };
}

/** 显式维护入口不作为模型自动调用的业务工具注册。 */
export async function maintain(store: Store, request: Request): Promise<Record<string, unknown>> {
  const action = choice(request.action, "action", ["backups", "backup", "restore", "recover"]);
  if (action === "backups") return { backups: catalog(store), maintenance: store.maintenance() };
  if (action === "recover") return recover(store);
  if (action === "restore") return restore(store, request);
  const gate = acquire(store);
  let record: BackupRecord;
  try { record = createBackup(store, "manual", gate.id); }
  catch (error) { abandon(store, gate, error); }
  release(store, gate);
  return { backup: record };
}
