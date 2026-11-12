import type { DatabaseSync } from "node:sqlite";
import { requireValue } from "./protocol.ts";

/** 会话归属独立于当前模型和 lease；短 ID 只用于房间内显示。 */
export interface SessionIdentity { session_id: string; member_id: string; short_id: string }

/** 完整会话 ID 是房间内唯一的 Pi 成员查找依据。 */
export function findSession(db: DatabaseSync, taskId: string, sessionId: string): SessionIdentity | undefined {
  return db.prepare("SELECT session_id,member_id,short_id FROM member_sessions WHERE task_id=? AND session_id=?").get(taskId, sessionId) as SessionIdentity | undefined;
}

/** 写事务内固定会话归属；短前缀冲突时逐字加长，已有短 ID 保持不变。 */
export function bindSession(db: DatabaseSync, taskId: string, sessionId: string, memberId: string): SessionIdentity {
  requireValue(db.isTransaction, "IDENTITY", "会话归属必须在写事务内登记");
  const prior = findSession(db, taskId, sessionId);
  if (prior) {
    requireValue(prior.member_id === memberId, "IDENTITY", "会话已经归属于另一个成员");
    return prior;
  }
  const chars = Array.from(sessionId);
  let size = Math.min(8, chars.length);
  let shortId = chars.slice(0, size).join("");
  while (db.prepare("SELECT 1 FROM member_sessions WHERE task_id=? AND short_id=?").get(taskId, shortId)) {
    requireValue(size < chars.length, "IDENTITY", "会话 ID 与已有短 ID 完全重合；请使用 Pi 提供的完整会话 UUID");
    shortId = chars.slice(0, ++size).join("");
  }
  db.prepare("INSERT INTO member_sessions(task_id,session_id,member_id,short_id) VALUES(?,?,?,?)").run(taskId, sessionId, memberId, shortId);
  return { session_id: sessionId, member_id: memberId, short_id: shortId };
}

/** 成员、作者和终端共用模型名称加会话短 ID 的显示格式。 */
export function sessionName(modelName: string, shortId: string): string {
  return `${modelName} (${shortId})`;
}
