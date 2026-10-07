import { pendAssignments } from "./assignments.ts";
import type { Store, Task } from "./database.ts";
import type { Request } from "./protocol.ts";
import { choice, newId, object, requireValue, text, uuid } from "./protocol.ts";

/** 当前推进状态独立版本；历史记录绑定其依据的不可变合同。 */
export interface Progress {
  id: string; task_id: string; version: number; event_seq: number; contract_revision: string;
  state: string; author: string; created_at: string;
}

/** 默认读取当前状态；历史文档只组合不晚于指定事件的状态。 */
export function progressAt(store: Store, task: Task, upper = task.event_seq): Progress | undefined {
  return store.one<Progress>("SELECT * FROM progress_revisions WHERE task_id=? AND event_seq<=? ORDER BY version DESC LIMIT 1", task.id, upper);
}

/** 对外保持完整的状态版本身份，不把文档版本当作状态锁。 */
export function progressView(progress: Progress | undefined): Record<string, unknown> | null {
  return progress ? { ...progress, state: JSON.parse(progress.state) } : null;
}

/** 状态写入只更新自身版本；初始化需显式 null，不能猜测旧自由文本。 */
export function updateProgress(store: Store, task: Task, request: Request, author: string): Record<string, unknown> {
  requireValue(["body", "restore_revision", "title", "summary", "status", "base_revision"].every(key => request[key] === undefined), "INPUT", "progress 与文档更新字段不能混用");
  const previous = progressAt(store, task);
  requireValue(request.base_progress === (previous?.id ?? null), "VERSION_CONFLICT", "推进状态基础版本已过期；首次初始化须 base_progress:null", { current_progress: previous?.id ?? null });
  requireValue(uuid(request.contract_revision, "contract_revision") === task.current_revision, "VERSION_CONFLICT", "推进状态依据的合同已变化", { current_revision: task.current_revision });
  const supplied = object(request.progress, "progress");
  requireValue(Object.keys(supplied).every(key => ["stage", "owner", "next_action", "blocked", "resume", "status"].includes(key)), "INPUT", "progress 包含未知字段");
  // blocked 统一保存为文本，布尔值和省略输入不改变状态记录及导出的结构。
  const blocked = supplied.blocked === true ? "有阻塞（未说明原因）" : supplied.blocked === false || supplied.blocked === undefined ? "" : supplied.blocked;
  const state = {
    stage: text(supplied.stage, "progress.stage", 256), owner: text(supplied.owner, "progress.owner", 512),
    next_action: text(supplied.next_action, "progress.next_action", 1024, true), blocked: text(blocked, "progress.blocked", 1024, true),
    resume: text(supplied.resume, "progress.resume", 1024, true), status: choice(supplied.status, "progress.status", ["in-progress", "completed", "blocked", "paused"]),
  };
  const id = newId();
  const version = (previous?.version ?? 0) + 1;
  requireValue(Number.isSafeInteger(version), "VERSION_LIMIT", "状态版本达到安全整数上限");
  if (request.preview === true) return { preview: true, base_progress: previous?.id ?? null, progress: state };
  const event = store.event(task, "progressed", id, `推进：${state.stage}；${state.owner}`, author);
  const progress: Progress = { id, task_id: task.id, version, event_seq: event.seq, contract_revision: task.current_revision, state: JSON.stringify(state), author, created_at: new Date().toISOString() };
  store.run("INSERT INTO progress_revisions VALUES(?,?,?,?,?,?,?,?)", id, task.id, version, event.seq, task.current_revision, progress.state, author, progress.created_at);
  if (state.status === "completed") pendAssignments(store, task, author);
  return { progress: progressView(progress), event };
}

/** 导出组合视图明确状态身份，旧文档正文仍保持不可变。 */
export function progressMarkdown(progress: Progress | undefined): string {
  if (!progress) return "";
  const state = JSON.parse(progress.state) as Record<string, string>;
  return `## 推进状态\n\n状态版本：${progress.id}；依据合同：${progress.contract_revision}\n\n` +
    [["阶段", "stage"], ["推进者", "owner"], ["下一项", "next_action"], ["阻塞", "blocked"], ["恢复条件", "resume"], ["状态", "status"]]
      .map(([label, key]) => `- ${label}：${state[key] || "无"}`).join("\n") + "\n\n";
}
