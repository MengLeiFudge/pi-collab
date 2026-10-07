import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicFile } from "./routing.js";
import { newId } from "./protocol.js";
/** 目录通知只表示可能有已提交变化，正文与交付位置仍以数据库和会话记录为准。 */
export const changeSignal = "changed.json";
/** 在宿主加载时固定绝对根，子进程显式继承，避免随不同项目 cwd 改变数据位置。 */
const configuredRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const agentDirectory = resolve(configuredRoot === "~" ? homedir() : /^~[/\\]/.test(configuredRoot) ? join(homedir(), configuredRoot.slice(2)) : configuredRoot);
/** Pi 与 CLI 共用数据根；导入此模块不打开 SQLite，也不创建目录。 */
export function dataDirectory() { return join(agentDirectory, "collab"); }
/** 提交成功后原子更新通知；通知失败不能把已提交写入报告为未提交。 */
export function notifyCommitted(directory) {
    try {
        atomicFile(join(directory, changeSignal), JSON.stringify({ change_id: newId(), committed_at: new Date().toISOString() }) + "\n");
        return [];
    }
    catch (error) {
        return [`数据已提交，自动投递通知失败：${error instanceof Error ? error.message : error}；下一次工具同步仍可读取内容`];
    }
}
