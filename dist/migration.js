import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "./signals.js";
import { databaseFilesystem } from "./paths.js";
import { processIdentity } from "./processes.js";
import { newId, requireValue } from "./protocol.js";
import { registerProtocol, schemaVersion, upgradeSchema } from "./schema.js";
/** 显式迁移已知旧 schema；备份和结构升级共用维护门禁。 */
export async function migrate() {
    const directory = dataDirectory();
    databaseFilesystem(directory);
    const path = join(directory, "collab.sqlite3");
    requireValue(existsSync(path) && !lstatSync(path).isSymbolicLink(), "SCHEMA", "迁移需要既有普通数据库文件");
    const db = new DatabaseSync(path, { timeout: 3000 });
    const id = newId();
    let acquired = false;
    let source;
    let version = 0;
    try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=ON");
        db.function("collab_protocol", { deterministic: true }, () => version);
        db.exec("BEGIN IMMEDIATE");
        version = Number(db.prepare("PRAGMA user_version").get().user_version);
        requireValue(version === 1 || version === 2, "SCHEMA", `仅支持显式 schema 1/2 → ${schemaVersion} 迁移`);
        const meta = db.prepare("SELECT * FROM metadata WHERE singleton=1").get();
        requireValue(!meta.maintenance, "MAINTENANCE", "已有维护操作，先用原版本 recover 核对");
        const busy = db.prepare("SELECT count(*) AS n FROM assignments a JOIN assignment_revisions r ON r.id=a.current_revision WHERE r.state!='released'").get();
        requireValue(busy.n === 0, "MAINTENANCE", "先停止写入并释放所有 assignment，再迁移");
        db.prepare("UPDATE metadata SET maintenance=? WHERE singleton=1").run(JSON.stringify({ id, kind: "backup", pid: process.pid, process_start: processIdentity(process.pid), started_at: new Date().toISOString(), phase: `schema-${schemaVersion}-migration` }));
        db.exec("COMMIT");
        acquired = true;
        const archive = join(directory, "migration-backups");
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        requireValue(!lstatSync(archive).isSymbolicLink(), "FILESYSTEM", "迁移备份目录不能是符号链接");
        source = join(archive, `schema-${version}-${id}.sqlite3`);
        await backup(db, source);
        if (process.platform !== "win32")
            chmodSync(source, 0o600);
        const copy = new DatabaseSync(source);
        try {
            copy.exec("PRAGMA trusted_schema=ON");
            copy.function("collab_protocol", { deterministic: true }, () => version);
            copy.prepare("UPDATE metadata SET maintenance=NULL WHERE singleton=1").run();
            requireValue(copy.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "BACKUP", "迁移备份完整性检查失败");
        }
        finally {
            copy.close();
        }
        db.exec("BEGIN IMMEDIATE");
        const gate = db.prepare("SELECT maintenance FROM metadata WHERE singleton=1").get();
        requireValue(JSON.parse(String(gate.maintenance)).id === id, "MAINTENANCE", "迁移门禁已变化");
        upgradeSchema(db, version);
        registerProtocol(db);
        db.prepare("UPDATE metadata SET maintenance=NULL WHERE singleton=1").run();
        db.exec("COMMIT");
        acquired = false;
        return { ok: true, schema_version: schemaVersion, previous_schema_version: version, backup: source };
    }
    catch (error) {
        if (db.isTransaction)
            db.exec("ROLLBACK");
        if (acquired) {
            db.function("collab_protocol", { deterministic: true }, () => version);
            db.prepare("UPDATE metadata SET maintenance=NULL WHERE singleton=1 AND json_extract(maintenance,'$.id')=?").run(id);
        }
        throw error;
    }
    finally {
        db.close();
    }
}
