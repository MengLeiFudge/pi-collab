import { createRoom } from "./creation.js";
import { listAssignments, pendAssignments, releaseByUser, showAssignment, updateAssignment } from "./assignments.js";
import { dutyInput, invitation, updateDuty } from "./duties.js";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { within } from "./paths.js";
import { Store } from "./database.js";
import { discoverRooms } from "./rooms.js";
import { progressAt, progressView, progressMarkdown, updateProgress } from "./progress.js";
import { snapshot, snapshotView } from "./snapshot.js";
import { beginWrite, finishWrite } from "./writes.js";
import { notificationFields } from "./notifications.js";
import { maintain, routineBackup } from "./maintenance.js";
import { inboxFilter, readInbox } from "./delivery.js";
import { notifyCommitted } from "./signals.js";
import { atomicFile, resolveProject } from "./routing.js";
import { anchor, bodyPage as page, choice, commands, documentDiff, excerpt, flag, integer, newId, object, optionalText, requireValue, text, uuid } from "./protocol.js";
import { hasQuery, readChats } from "./chat.js";
import { authorFor, currentMember, joinRoom, publicAuthor, requireMember, roomInfo, selectedModel } from "./members.js";
/** 所有日常入口都使用相同身份检查，CLI 环境注入发生在此之前。 */
export function requestFrom(value, command) {
    const input = object(value, "request");
    const name = choice(command, "command", [...commands, "maintain"]);
    requireValue(input.delivery === undefined && input.part === undefined, "INPUT", "不支持 delivery/part；read 请使用 view:content 或 view:index");
    requireValue(!flag(input, "preview") || name === "update", "INPUT", "preview 仅用于 update");
    return { ...input, command: name, client: text(input.client, "client", 64), session_id: text(input.session_id, "session_id", 256) };
}
/** 查询对应任务的完整版本，拒绝引用其他任务的版本。 */
function revision(store, task, id = task.current_revision) {
    const value = store.one("SELECT * FROM revisions WHERE id=? AND task_id=?", id, task.id);
    requireValue(value, "NOT_FOUND", "文档版本不存在", { revision_id: id });
    return value;
}
/** 业务响应总是携带当前世代，序号不是永久引用。 */
function identity(store, task) {
    const meta = store.metadata();
    return { database_id: meta.database_id, generation: meta.generation, project_id: task.project_id, task_id: task.id };
}
/** 默认摘要不替代 show 的完整合同。 */
function summary(version, progress) {
    return { revision_id: version.id, version: version.version, title: excerpt(version.title, 120), summary: excerpt(version.summary), status: progress ? JSON.parse(progress.state).status : version.status };
}
/** 每次查询采样当前计数，计数结果不产生阅读检查点。 */
function counts(store, task, after, request) {
    const filter = inboxFilter(store, task, request, after.seq, task.event_seq);
    const unseen = store.one(`SELECT count(*) AS n FROM events WHERE ${filter.sql}`, ...filter.values).n;
    return { new_events: unseen, open_issues: store.one("SELECT count(*) AS n FROM issues WHERE task_id=? AND state='open'", task.id).n, current_seq: task.event_seq };
}
/** 订阅起点与任务摘要在同一读取事务内取得，不跨过绑定后到来的事件。 */
function openedTask(store, task, request) {
    const window = readWindow(store, task, { ...request, window: undefined }, anchor(undefined));
    const cursor = { database_id: window.database_id, generation: window.generation, task_id: task.id, after: window.upper };
    const joined = flag(request, "join") ? joinRoom(store, task, request, cursor) : undefined;
    const effective = joined ? { ...request, membership: joined.membership } : request;
    requireValue(request.duty === undefined || joined, "INPUT", "已有身份的职责变更请用 update duty，并提供 base_duty");
    const room = roomInfo(store, task, effective);
    // 加入只预览摘要，不能让正文分配或查询元数据预算挤掉最近十条的定位。
    const messages = store.all("SELECT id,chat_no,summary FROM messages WHERE task_id=? ORDER BY chat_no DESC LIMIT 10", task.id).reverse().map(message => ({ id: message.id, chat_no: message.chat_no, summary: excerpt(message.summary, 80), show: { object_id: message.id } }));
    const recent = { view: "preview", messages, read: { task_id: task.id, latest: 10 } };
    const progress = progressAt(store, task);
    const result = { ...identity(store, task), authority: "collab", task: summary(revision(store, task), progress),
        cursor: joined?.cursor ?? cursor, ...(joined ? { membership: joined.membership, duty_change: joined.duty_change } : {}), room, recent, counts: counts(store, task, cursor.after, effective),
        progress: progressView(progress), contract: { task_id: task.id, object_id: task.current_revision }, issues: { task_id: task.id, view: "index", after: { seq: 0, event_id: null } } };
    const members = room.members;
    while (Buffer.byteLength(JSON.stringify({ ok: true, ...result })) > 12 * 1024 && members.length > 1) {
        members.pop();
        room.members_after = members.at(-1).id;
    }
    requireValue(Buffer.byteLength(JSON.stringify({ ok: true, ...result })) <= 12 * 1024, "OUTPUT_BUDGET", "房间概况超过预算，请按对象展开合同或消息");
    return result;
}
/** 固定上界及文档版本按数据库快照验证，客户端不能任意拼接分页视图。 */
function readWindow(store, task, request, after) {
    const meta = store.metadata();
    let upper;
    if (request.window !== undefined) {
        const supplied = object(request.window, "window");
        requireValue(supplied.database_id === meta.database_id && supplied.generation === meta.generation && supplied.task_id === task.id, "GENERATION_CHANGED", "分页凭证身份或世代不匹配");
        upper = store.checkAnchor(task, supplied.upper);
    }
    else {
        const last = store.one("SELECT id FROM events WHERE task_id=? AND seq=?", task.id, task.event_seq);
        upper = { seq: task.event_seq, event_id: last?.id ?? null };
    }
    requireValue(after.seq <= upper.seq, "INPUT", "after 超过本次固定上界");
    const version = store.one("SELECT id FROM revisions WHERE task_id=? AND event_seq<=? ORDER BY event_seq DESC LIMIT 1", task.id, upper.seq);
    requireValue(version, "INPUT", "固定上界早于任务创建");
    if (request.window !== undefined)
        requireValue(object(request.window, "window").revision_id === version.id, "INPUT", "分页文档版本与上界不一致");
    return { database_id: meta.database_id, generation: meta.generation, task_id: task.id, upper, revision_id: version.id };
}
/** 核心 read 无服务端游标；下一页输入由调用方保存和传回。 */
function readTask(store, task, request) {
    if (request.view === "assignments") {
        requireValue(!hasQuery(request), "INPUT", "分工列表不能混用消息选择器");
        return { ...identity(store, task), ...listAssignments(store, task, request) };
    }
    if (hasQuery(request))
        return readChats(store, task, request);
    if (flag(request, "automatic"))
        requireMember(store, task, request);
    const after = store.checkAnchor(task, request.after);
    if (after.seq)
        uuid(request.generation, "generation");
    const currentCounts = counts(store, task, after, request);
    const sampled = new Date().toISOString();
    if (flag(request, "counts_only"))
        return { ...identity(store, task), counts: currentCounts, sampled_at: sampled };
    const view = choice(request.view ?? "content", "view", ["content", "index"]);
    const window = readWindow(store, task, view === "index" ? request : { ...request, window: undefined }, after);
    if (view === "content")
        return { ...readInbox(store, task, request, window),
            membership_status: currentMember(store, task, request) ? "active" : request.membership ? "superseded" : "read-only" };
    const budget = integer(request.max_bytes, "max_bytes", 12 * 1024, 64 * 1024);
    requireValue(budget >= 4096, "INPUT", "max_bytes 至少为 4096");
    const issuesAfter = request.issues_after === undefined ? "" : uuid(request.issues_after, "issues_after");
    const events = store.all("SELECT id,seq,kind,object_id,summary FROM events WHERE task_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 32", task.id, after.seq, window.upper.seq).map(event => ({ ...event, summary: excerpt(event.summary, 120), excerpt: true }));
    const issues = store.all("SELECT i.*,m.summary FROM issues i JOIN messages m ON m.id=i.id WHERE i.task_id=? AND i.state='open' AND i.id>? ORDER BY i.id LIMIT 32", task.id, issuesAfter).map(issue => ({ id: issue.id, revision_id: issue.revision_id, version: issue.version, summary: excerpt(issue.summary, 120), excerpt: true }));
    const issueTotal = store.one("SELECT count(*) AS n FROM issues WHERE task_id=? AND state='open' AND id>?", task.id, issuesAfter).n;
    const version = revision(store, task, window.revision_id);
    const result = () => {
        const last = events.at(-1);
        const nextAfter = last ? { seq: last.seq, event_id: last.id } : after;
        const remaining = window.upper.seq - nextAfter.seq;
        const issueRemaining = issueTotal - issues.length;
        const next = { database_id: window.database_id, generation: window.generation, task_id: task.id, after: nextAfter, view: "index" };
        if (remaining)
            next.window = window;
        if (issueRemaining)
            next.issues_after = issues.at(-1)?.id || issuesAfter;
        return {
            ...identity(store, task), view: "index", task: summary(version, progressAt(store, task, window.upper.seq)), events_up_to: window.upper.seq, window,
            events, event_remaining: remaining, issues, issues_remaining: issueRemaining,
            issues_as_of_seq: task.event_seq, next, counts: currentCounts, sampled_at: sampled,
        };
    };
    // 为两类列表各保留至少一项，再按最终 JSON 字节量削减较长的一方。
    while (Buffer.byteLength(JSON.stringify({ ok: true, ...result() })) > budget) {
        requireValue(events.length > 1 || issues.length > 1, "OUTPUT_BUDGET", "输出预算不足，请增大 max_bytes");
        if (events.length > 1 && (issues.length <= 1 || events.length >= issues.length))
            events.pop();
        else
            issues.pop();
    }
    return result();
}
/** 展开对象从稳定 UUID 定位，不凭显示序号猜测对象。 */
function showTask(store, task, request) {
    const id = request.object_id === undefined ? task.current_revision : uuid(request.object_id, "object_id");
    const version = store.one("SELECT * FROM revisions WHERE id=? AND task_id=?", id, task.id);
    if (version) {
        const before = request.compare_to === undefined ? undefined : revision(store, task, uuid(request.compare_to, "compare_to"));
        const progress = progressAt(store, task, request.object_id === undefined ? task.event_seq : version.event_seq);
        return page(before ? documentDiff(before, version) : version.body, request, { ...identity(store, task), ...summary(version, progress), progress: progressView(progress), object_id: id, compare_to: before?.id });
    }
    const progress = store.one("SELECT * FROM progress_revisions WHERE id=? AND task_id=?", id, task.id);
    if (progress)
        return { ...identity(store, task), progress: progressView(progress) };
    const assignment = showAssignment(store, task, id);
    if (assignment)
        return { ...identity(store, task), assignment };
    const snap = store.one("SELECT * FROM snapshots WHERE id=? AND task_id=?", id, task.id);
    if (snap)
        return { ...identity(store, task), snapshot: snapshotView(snap) };
    const message = store.one("SELECT * FROM messages WHERE id=? AND task_id=?", id, task.id);
    if (message) {
        const { body, evidence, author, reply_to, reply_revision, ...details } = message;
        const reply = reply_to ? { kind: "message", id: reply_to } : reply_revision ? { kind: "revision", id: reply_revision } : null;
        return page(body, request, { ...identity(store, task), message: { ...details, reply_to: reply, summary: excerpt(message.summary), author: publicAuthor(author), evidence: JSON.parse(evidence) }, issue: store.one("SELECT * FROM issues WHERE id=?", id) });
    }
    const event = store.one("SELECT * FROM events WHERE (id=? OR (kind='duty-changed' AND object_id=?)) AND task_id=?", id, id, task.id);
    requireValue(event, "NOT_FOUND", "对象不存在或已不在恢复后的数据库中", { object_id: id });
    return { ...identity(store, task), event };
}
/** 普通写入与快照登记复用身份、请求去重和结果提交边界。 */
function writeTask(store, request) {
    const context = beginWrite(store, request);
    if (context.prior)
        return context.prior;
    const { task, author, memberId } = context;
    let value;
    if (request.command === "post")
        value = post(store, task, request, author, memberId);
    else if (request.command === "update") {
        requireValue([request.progress, request.duty, request.assignment].filter(value => value !== undefined).length <= 1, "INPUT", "progress/duty/assignment 不能混用");
        if (request.duty !== undefined || request.assignment !== undefined)
            requireValue(["body", "base_revision", "title", "summary", "status", "restore_revision", "base_progress"].every(key => request[key] === undefined), "INPUT", "职责/分工不能混用文档或推进状态字段");
        const member = requireMember(store, task, request);
        value = request.duty !== undefined ? updateDuty(store, task, request, member, author) : request.assignment !== undefined ? updateAssignment(store, task, request, member, author) : request.progress === undefined ? update(store, task, request, author) : updateProgress(store, task, request, author);
    }
    else
        value = resolveIssue(store, task, request, author);
    return finishWrite(store, request, context, value);
}
/** 消息和初始意见状态与发布事件同事务提交。 */
function post(store, task, request, author, memberId) {
    const notice = notificationFields(store, task, request);
    const body = text(request.body, "body", 512 * 1024);
    const kind = choice(request.kind ?? "message", "kind", ["message", "issue"]);
    const brief = text(request.summary ?? excerpt(body), "summary", 2048);
    let reply = null;
    let replyRevision = null;
    if (request.reply_to !== undefined) {
        const target = typeof request.reply_to === "string" ? { id: request.reply_to, kind: undefined } : object(request.reply_to, "reply_to");
        const id = uuid(target.id, "reply_to.id");
        const kind = target.kind === undefined ? undefined : choice(target.kind, "reply_to.kind", ["message", "revision"]);
        if (kind !== "revision" && store.one("SELECT id FROM messages WHERE task_id=? AND id=?", task.id, id))
            reply = id;
        else if (kind !== "message" && store.one("SELECT id FROM revisions WHERE task_id=? AND id=?", task.id, id))
            replyRevision = id;
        requireValue(reply || replyRevision, "NOT_FOUND", "回复目标不存在或不属于此房间");
    }
    const evidence = request.evidence ?? [];
    requireValue(Array.isArray(evidence) && evidence.length <= 8, "INPUT", "evidence 最多 8 项");
    evidence.forEach(value => text(value, "evidence", 512));
    const id = newId();
    const event = store.event(task, "posted", id, brief, author);
    const chatNo = store.one("SELECT coalesce(max(chat_no),0)+1 AS n FROM messages WHERE task_id=?", task.id).n;
    requireValue(Number.isSafeInteger(chatNo), "SEQUENCE_LIMIT", "聊天序号已达安全整数上限");
    store.run("INSERT INTO messages(id,task_id,kind,body,summary,author,reply_to,evidence,event_seq,created_at,chat_no,member_id,reply_revision,priority,reason,audience) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, task.id, kind, body, brief, author, reply, JSON.stringify(evidence), event.seq, new Date().toISOString(), chatNo, memberId, replyRevision, notice.priority, notice.reason, notice.audience);
    const issueRevision = kind === "issue" ? newId() : undefined;
    if (issueRevision)
        store.run("INSERT INTO issues VALUES(?,?,?,?,?,?,?)", id, task.id, "open", issueRevision, 1, null, event.seq);
    return { message_id: id, chat_no: chatNo, event, issue_revision: issueRevision, priority: notice.priority, notification: notice.notification };
}
/** 完整版本更新与历史正文恢复统一产生新版本。 */
function update(store, task, request, author) {
    const before = revision(store, task);
    requireValue(request.status === undefined || !progressAt(store, task), "INPUT", "已有结构化推进状态，请通过 progress.status 更新任务状态");
    requireValue(uuid(request.base_revision, "base_revision") === before.id, "VERSION_CONFLICT", "任务基础版本已过期", { current_revision: before.id });
    requireValue(!(request.restore_revision !== undefined && request.body !== undefined), "INPUT", "body 和 restore_revision 不能同时提供");
    const restored = request.restore_revision === undefined ? undefined : revision(store, task, uuid(request.restore_revision, "restore_revision"));
    const body = restored?.body ?? (request.body === undefined ? before.body : text(request.body, "body", 2 * 1024 * 1024, true));
    const next = {
        ...before, id: newId(), version: before.version + 1, event_seq: task.event_seq + 1, body, author, created_at: new Date().toISOString(),
        title: optionalText(request, "title", 512) ?? before.title,
        summary: optionalText(request, "summary", 2048) ?? before.summary,
        status: request.status === undefined ? before.status : choice(request.status, "status", ["in-progress", "completed", "blocked", "paused"]),
    };
    requireValue(Number.isSafeInteger(next.version), "VERSION_LIMIT", "文档版本达到安全整数上限");
    if (flag(request, "preview"))
        return page(documentDiff(before, next), request, { preview: true, base_revision: before.id, proposed: summary(next) });
    const event = store.event(task, "updated", next.id, next.summary, author);
    store.run("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?)", next.id, task.id, next.version, event.seq, next.title, next.summary, next.status, next.body, author, next.created_at);
    store.run("UPDATE tasks SET current_revision=? WHERE id=?", next.id, task.id);
    if (next.status === "completed" && !progressAt(store, task))
        pendAssignments(store, task, author);
    return { ...summary(next), event, restored_from: restored?.id };
}
/** 状态修改保留解释消息，并以独立 UUID 版本进行乐观检查。 */
function resolveIssue(store, task, request, author) {
    const id = uuid(request.issue_id, "issue_id");
    const issue = store.one("SELECT * FROM issues WHERE id=? AND task_id=?", id, task.id);
    requireValue(issue, "NOT_FOUND", "意见不存在");
    requireValue(uuid(request.base_revision, "base_revision") === issue.revision_id, "VERSION_CONFLICT", "意见状态已变化", { current_revision: issue.revision_id });
    const state = choice(request.state, "state", ["open", "addressed", "rejected"]);
    const reason = uuid(request.resolution_id, "resolution_id");
    requireValue(reason !== id && store.one("SELECT id FROM messages WHERE task_id=? AND id=?", task.id, reason), "INPUT", "必须关联同任务内另一条解释消息");
    const nextId = newId();
    // 状态事件固定该次处理引用；之后重新打开意见不会改变历史通知的依据。
    const event = store.event(task, "resolved", id, `意见状态：${state}；resolution_id: ${reason}`, author);
    requireValue(Number.isSafeInteger(issue.version + 1), "VERSION_LIMIT", "意见版本达到安全整数上限");
    store.run("UPDATE issues SET state=?,revision_id=?,version=version+1,resolution_id=?,updated_seq=? WHERE id=?", state, nextId, reason, event.seq, id);
    return { issue_id: id, state, revision_id: nextId, version: issue.version + 1, resolution_id: reason, event };
}
/** 导出带固定版本身份的审阅材料，不能覆盖运行数据或已有文件。 */
function exportTask(store, task, request) {
    const version = revision(store, task, request.object_id === undefined ? task.current_revision : uuid(request.object_id, "object_id"));
    const meta = identity(store, task);
    const upper = request.object_id === undefined ? task.event_seq : version.event_seq;
    const event = store.one("SELECT id FROM events WHERE task_id=? AND seq=?", task.id, upper);
    const progress = progressAt(store, task, upper);
    const header = { ...meta, progress_id: progress?.id, revision_id: version.id, version: version.version, event_id: event.id, events_up_to: upper, exported_at: new Date().toISOString(), read_only: true };
    const markdown = `<!-- collab-export ${JSON.stringify(header)} -->\n\n${progressMarkdown(progress)}${version.body}`;
    if (request.output === undefined)
        return page(markdown, request, header);
    const output = resolve(text(request.output, "output", 4096));
    const target = resolve(realpathSync(dirname(output)), basename(output));
    const dataRoot = realpathSync(store.directory);
    requireValue(!within(dataRoot, target), "EXPORT", "导出不能覆盖运行数据");
    requireValue(!existsSync(target), "EXPORT", "导出目标已存在，请选择新路径");
    atomicFile(target, markdown, true);
    return { ...header, output: target, bytes: Buffer.byteLength(markdown) };
}
/** 通知发生在事务提交之后；失败作为告警保留原提交结果。 */
function committed(store, result) {
    const warnings = [...(result.warnings ?? []), ...notifyCommitted(store.directory)];
    return { ...result, ...(warnings.length ? { warnings } : {}) };
}
/** 日常 CLI 和 Pi 共用数据库主路径；每条命令持有并释放自己的连接。 */
export async function execute(request, signal) {
    const creating = request.command === "open" && flag(request, "create") && request.task_id === undefined;
    requireValue(request.command !== "snapshot" || request.task_id !== undefined, "INPUT", "snapshot 必须指定 task_id");
    if (creating) {
        requireValue(flag(request, "join"), "JOIN_REQUIRED", "建房需要同时加入，请使用原生 Pi 入口");
        selectedModel(request);
        if (request.duty !== undefined)
            dutyInput(request.duty);
        uuid(request.request_id, "request_id");
    }
    const store = new Store(creating);
    try {
        const response = await executeStored(store, request, signal);
        const warnings = [...(request.command === "open" || request.command === "maintain" ? store.warnings : []), ...(response.warnings ?? [])];
        return warnings.length ? { ...response, warnings } : response;
    }
    finally {
        store.close();
    }
}
/** 单连接业务调度与外层资源释放分开；发现和维护入口附带环境告警。 */
async function executeStored(store, request, signal) {
    const creating = request.command === "open" && flag(request, "create") && request.task_id === undefined;
    if (request.command === "maintain") {
        const result = { ok: true, ...await maintain(store, request) };
        return ["restore", "recover"].includes(String(request.action)) ? committed(store, result) : result;
    }
    if (request.command === "snapshot") {
        const result = await snapshot(store, request, signal);
        return committed(store, { ok: true, ...result, warnings: routineBackup(store) });
    }
    if (creating && request.prepare_creation === true) {
        return store.atomic(false, () => {
            const meta = store.gate();
            return { ok: true, database_id: meta.database_id, generation: meta.generation, prepared: true, request_id: request.request_id };
        });
    }
    if (creating) {
        const location = resolveProject(store, request);
        const result = store.atomic(true, () => {
            const created = createRoom(store, request, location);
            return { ok: true, ...openedTask(store, created.task, request), created: created.created };
        });
        return committed(store, { ...result, warnings: routineBackup(store) });
    }
    const memberAction = request.command === "open" && ["leave", "preferences", "release-scopes"].includes(String(request.action));
    const writing = ["post", "update", "resolve"].includes(request.command);
    const joining = request.command === "open" && flag(request, "join");
    const tracking = request.command === "read" && hasQuery(request) && request.membership !== undefined;
    const result = store.atomic(writing || joining || tracking || memberAction, () => {
        store.gate();
        if (request.command === "open" && request.action === "rooms") {
            requireValue(!joining, "INPUT", "房间发现不取得身份");
            return { database_id: store.metadata().database_id, generation: store.metadata().generation, ...discoverRooms(store, request) };
        }
        if (request.command === "open" && request.task_id === undefined) {
            requireValue(!joining, "INPUT", "加入房间需要 task_id");
            const projectId = request.project_id === undefined ? null : uuid(request.project_id, "project_id");
            const afterId = request.tasks_after === undefined ? "" : uuid(request.tasks_after, "tasks_after");
            const tasks = store.all("SELECT * FROM tasks WHERE (? IS NULL OR project_id=?) AND id>? ORDER BY id LIMIT 21", projectId, projectId, afterId);
            const visible = tasks.slice(0, 20);
            return { database_id: store.metadata().database_id, generation: store.metadata().generation,
                tasks: visible.map(task => ({ task_id: task.id, project_id: task.project_id, ...summary(revision(store, task), progressAt(store, task)) })),
                tasks_after: tasks.length > 20 ? visible.at(-1).id : null };
        }
        const task = store.task(uuid(request.task_id, "task_id"));
        store.guard(request, task, writing);
        if (request.project_id !== undefined)
            requireValue(request.project_id === task.project_id, "PROJECT", "任务不属于指定项目");
        if (request.command === "open" && request.action === "invite") {
            requireValue(!joining, "INPUT", "邀请查询不取得身份");
            return { ...identity(store, task), ...invitation(store, task, request) };
        }
        if (memberAction) {
            if (request.action === "release-scopes") {
                selectedModel(request);
                return releaseByUser(store, task, request);
            }
            store.guard(request, task, true);
            const member = requireMember(store, task, request);
            if (request.action === "leave") {
                pendAssignments(store, task, authorFor(request, member), member.id);
                store.run("UPDATE members SET owner_client=NULL,owner_session=NULL,lease=NULL,claimed_generation=NULL,updated_at=? WHERE id=?", new Date().toISOString(), member.id);
                return { ...identity(store, task), left: true };
            }
            requireValue(typeof request.urgent_enabled === "boolean", "INPUT", "urgent_enabled 必须为布尔值");
            store.run("UPDATE members SET urgent_enabled=? WHERE id=?", request.urgent_enabled ? 1 : 0, member.id);
            return { ...identity(store, task), urgent_enabled: request.urgent_enabled };
        }
        if (writing)
            return writeTask(store, request);
        if (request.command === "read")
            return readTask(store, task, request);
        if (request.command === "show")
            return showTask(store, task, request);
        if (request.command === "export")
            return exportTask(store, task, request);
        return openedTask(store, task, request);
    });
    const warnings = (writing || joining || memberAction) && !flag(request, "preview") ? routineBackup(store) : [];
    const response = { ok: true, ...result, ...(warnings.length ? { warnings } : {}) };
    return (writing || joining || memberAction) && !flag(request, "preview") ? committed(store, response) : response;
}
