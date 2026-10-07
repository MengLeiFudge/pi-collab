import { pendAssignments } from "./assignments.js";
import { choice, newId, object, requireValue, text, uuid } from "./protocol.js";
/** 默认读取当前状态；历史文档只组合不晚于指定事件的状态。 */
export function progressAt(store, task, upper = task.event_seq) {
    return store.one("SELECT * FROM progress_revisions WHERE task_id=? AND event_seq<=? ORDER BY version DESC LIMIT 1", task.id, upper);
}
/** 对外保持完整的状态版本身份，不把文档版本当作状态锁。 */
export function progressView(progress) {
    return progress ? { ...progress, state: JSON.parse(progress.state) } : null;
}
/** 状态写入只更新自身版本；初始化需显式 null，不能猜测旧自由文本。 */
export function updateProgress(store, task, request, author) {
    requireValue(["body", "restore_revision", "title", "summary", "status", "base_revision"].every(key => request[key] === undefined), "INPUT", "progress 与文档更新字段不能混用");
    const previous = progressAt(store, task);
    requireValue(request.base_progress === (previous?.id ?? null), "VERSION_CONFLICT", "推进状态基础版本已过期；首次初始化须 base_progress:null", { current_progress: previous?.id ?? null });
    requireValue(uuid(request.contract_revision, "contract_revision") === task.current_revision, "VERSION_CONFLICT", "推进状态依据的合同已变化", { current_revision: task.current_revision });
    const supplied = object(request.progress, "progress");
    requireValue(Object.keys(supplied).every(key => ["stage", "owner", "next_action", "blocked", "resume", "status"].includes(key)), "INPUT", "progress 包含未知字段");
    const state = {
        stage: text(supplied.stage, "progress.stage", 256), owner: text(supplied.owner, "progress.owner", 512),
        next_action: text(supplied.next_action, "progress.next_action", 1024, true), blocked: text(supplied.blocked, "progress.blocked", 1024, true),
        resume: text(supplied.resume, "progress.resume", 1024, true), status: choice(supplied.status, "progress.status", ["in-progress", "completed", "blocked", "paused"]),
    };
    const id = newId();
    const version = (previous?.version ?? 0) + 1;
    requireValue(Number.isSafeInteger(version), "VERSION_LIMIT", "状态版本达到安全整数上限");
    if (request.preview === true)
        return { preview: true, base_progress: previous?.id ?? null, progress: state };
    const event = store.event(task, "progressed", id, `推进：${state.stage}；${state.owner}`, author);
    const progress = { id, task_id: task.id, version, event_seq: event.seq, contract_revision: task.current_revision, state: JSON.stringify(state), author, created_at: new Date().toISOString() };
    store.run("INSERT INTO progress_revisions VALUES(?,?,?,?,?,?,?,?)", id, task.id, version, event.seq, task.current_revision, progress.state, author, progress.created_at);
    if (state.status === "completed")
        pendAssignments(store, task, author);
    return { progress: progressView(progress), event };
}
/** 导出组合视图明确状态身份，旧文档正文仍保持不可变。 */
export function progressMarkdown(progress) {
    if (!progress)
        return "";
    const state = JSON.parse(progress.state);
    return `## 推进状态\n\n状态版本：${progress.id}；依据合同：${progress.contract_revision}\n\n` +
        [["阶段", "stage"], ["推进者", "owner"], ["下一项", "next_action"], ["阻塞", "blocked"], ["恢复条件", "resume"], ["状态", "status"]]
            .map(([label, key]) => `- ${label}：${state[key] || "无"}`).join("\n") + "\n\n";
}
