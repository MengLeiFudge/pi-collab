import { realpathSync } from "node:fs";
import { overlaps, scopePaths } from "./paths.js";
import { publicAuthor } from "./members.js";
import { canonical, choice, digest, excerpt, flag, integer, newId, object, requireValue, text, uuid } from "./protocol.js";
import { resolveProject } from "./routing.js";
const current = "SELECT r.*,a.task_id,a.member_id FROM assignments a JOIN assignment_revisions r ON r.id=a.current_revision";
/** 创建/接续在同一写事务内复核所有未释放范围，返回可定位的占用方。 */
function checkScopes(store, scopes, except) {
    const rows = store.all("SELECT r.*,a.task_id,a.member_id,a.conflict_paths FROM assignments a JOIN assignment_revisions r ON r.id=a.current_revision WHERE r.state!='released'");
    for (const row of rows) {
        if (row.assignment_id === except)
            continue;
        const collision = JSON.parse(row.conflict_paths).find(old => scopes.some(next => overlaps(old.key, next.key)));
        if (!collision)
            continue;
        const room = store.one("SELECT r.title FROM tasks t JOIN revisions r ON r.id=t.current_revision WHERE t.id=?", row.task_id);
        const member = store.one("SELECT name FROM members WHERE id=?", row.member_id);
        const since = store.one("SELECT created_at FROM assignment_revisions WHERE assignment_id=? AND version=1", row.assignment_id);
        requireValue(false, "SCOPE_CONFLICT", "写入范围已被登记；请协调交接或由用户明确解除", { room: room.title, task_id: row.task_id, member: member.name,
            workspace: row.workspace, path: collision.path, since: since.created_at, stage: row.stage, state: row.state,
            assignment_id: row.assignment_id, base_assignment: row.id, show: { task_id: row.task_id, object_id: row.id } });
    }
}
/** 修订、指针与系统事件原子提交；系统事件本身不唤醒其他模型。 */
function save(store, task, row, scopes) {
    const event = store.event(task, "assigned", row.id, `范围 ${row.state}：${row.stage}`, row.author);
    row.event_seq = event.seq;
    store.run("INSERT INTO assignment_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row.id, row.assignment_id, row.version, row.workspace, row.scopes, row.state, row.stage, row.deliverable, row.contract_revision, row.basis, row.blocked, row.lease, row.stopped, row.author, row.reason, row.created_at, row.event_seq);
    store.run("UPDATE assignments SET current_revision=? WHERE id=?", row.id, row.assignment_id);
    if (scopes || row.state === "released")
        store.run("UPDATE assignments SET conflict_paths=? WHERE id=?", row.state === "released" ? null : JSON.stringify(scopes), row.assignment_id);
    return row;
}
/** SQLite 的 JSON 文本在输出边界解码；引用修订 UUID 才能完成或释放登记。 */
export function assignmentView(row) {
    const { lease: _lease, scopes, author, ...view } = row;
    return { ...view, author: publicAuthor(author), scopes: JSON.parse(scopes).map(scope => scope.path) };
}
/** 列表用于房间概况和用户清理废弃房间；游标只影响该列表，不影响消息阅读。 */
export function listAssignments(store, task, request) {
    const after = request.assignments_after === undefined ? "" : uuid(request.assignments_after, "assignments_after");
    const all = flag(request, "all_rooms");
    const rows = store.all(`${current} WHERE (? OR a.task_id=?) AND a.id>? AND (? OR r.state!='released') ORDER BY a.id LIMIT 11`, all ? 1 : 0, task.id, after, flag(request, "include_released") ? 1 : 0);
    const visible = rows.slice(0, 10);
    const assignments = visible.map(row => ({ id: row.id, assignment_id: row.assignment_id, task_id: row.task_id, state: row.state, stage: excerpt(row.stage, 80), workspace: excerpt(row.workspace, 256),
        scope_count: JSON.parse(row.scopes).length, show: { task_id: row.task_id, object_id: row.id },
        member: store.one("SELECT name FROM members WHERE id=?", row.member_id).name,
        title: store.one("SELECT r.title FROM tasks t JOIN revisions r ON r.id=t.current_revision WHERE t.id=?", row.task_id).title }));
    while (assignments.length > 1 && Buffer.byteLength(JSON.stringify(assignments)) > 10 * 1024)
        assignments.pop();
    return { view: "assignments", assignments, assignments_after: rows.length > assignments.length ? assignments.at(-1).assignment_id : null };
}
/** show 接受登记 ID 或历史修订 ID；不把历史状态改写成当前状态。 */
export function showAssignment(store, task, id) {
    const row = store.one(`${current} WHERE a.id=? AND a.task_id=?`, id, task.id) ??
        store.one("SELECT r.*,a.task_id,a.member_id FROM assignment_revisions r JOIN assignments a ON a.id=r.assignment_id WHERE r.id=? AND a.task_id=?", id, task.id);
    return row ? assignmentView(row) : undefined;
}
/** 离开/任务完成只把仍占用的登记标为待释放；不猜测旧命令已退出。 */
export function pendAssignments(store, task, author, memberId) {
    for (const row of store.all(`${current} WHERE a.task_id=? AND (? IS NULL OR a.member_id=?) AND r.state='active'`, task.id, memberId ?? null, memberId ?? null)) {
        save(store, task, { ...row, id: newId(), version: row.version + 1, state: "release-pending", author, reason: "离开或任务完成，仍需确认停写", created_at: new Date().toISOString() });
    }
}
/** 分工写入复用普通请求去重；注册、续接、完成和用户释放均有明确输入边界。 */
export function updateAssignment(store, task, request, member, author) {
    requireValue(request.preview !== true, "INPUT", "分工使用只读列表核对，不支持 preview");
    const input = object(request.assignment, "assignment");
    const action = choice(input.action, "assignment.action", ["register", "resume", "update", "complete", "release", "user-release"]);
    const reason = text(input.reason, "assignment.reason", 1024);
    if (action !== "user-release")
        requireValue(member, "JOIN_REQUIRED", "请先加入房间");
    if (["register", "resume", "update"].includes(action)) {
        const status = store.one("SELECT coalesce((SELECT json_extract(state,'$.status') FROM progress_revisions WHERE task_id=? ORDER BY version DESC LIMIT 1),r.status) AS status FROM revisions r WHERE r.id=?", task.id, task.current_revision).status;
        requireValue(status !== "completed", "TASK_COMPLETED", "任务已完成，先明确恢复推进再开始新的写入范围");
    }
    if (action === "register") {
        requireValue(uuid(input.contract_revision, "contract_revision") === task.current_revision, "VERSION_CONFLICT", "分工依据的合同已改变");
        const workspace = realpathSync(text(input.workspace, "workspace", 4096));
        const location = resolveProject(store, { ...request, project_id: undefined, project_root: workspace });
        const project = "id" in location ? location.id : store.one("SELECT id FROM projects WHERE locator=?", location.locator)?.id;
        requireValue(project === task.project_id, "PROJECT", "写入范围工作区不属于当前项目");
        const scopes = scopePaths(workspace, input.scope);
        checkScopes(store, scopes);
        const id = newId(), revision = newId();
        const row = { id: revision, assignment_id: id, task_id: task.id, member_id: member.id, version: 1,
            workspace, scopes: JSON.stringify(scopes), state: "active", stage: text(input.stage, "stage", 256), deliverable: text(input.deliverable, "deliverable", 1024),
            contract_revision: task.current_revision, basis: text(input.basis, "basis", 1024), blocked: "", lease: member.lease, stopped: 0,
            author, reason, created_at: new Date().toISOString(), event_seq: 0 };
        store.run("INSERT INTO assignments(id,task_id,member_id,current_revision) VALUES(?,?,?,?)", id, task.id, member.id, revision);
        return { assignment: assignmentView(save(store, task, row, scopes)) };
    }
    requireValue(input.scope === undefined && input.workspace === undefined, "INPUT", "已有登记不能换范围，先释放后新建");
    if (!["resume", "update"].includes(action))
        requireValue(["stage", "deliverable", "basis", "contract_revision"].every(key => input[key] === undefined), "INPUT", "交付或释放不改写原分工，进展请先 update");
    const targets = input.targets;
    requireValue(Array.isArray(targets) && targets.length > 0 && targets.length <= 20, "INPUT", "targets 需要 1..20 个 {id,base_assignment}");
    const rows = targets.map(value => {
        const target = object(value, "target");
        const row = store.one(`${current} WHERE a.id=?`, uuid(target.id, "target.id"));
        requireValue(row, "NOT_FOUND", "登记不存在");
        requireValue(row.id === uuid(target.base_assignment, "base_assignment"), "VERSION_CONFLICT", "登记版本已改变", { current_assignment: row.id });
        requireValue(row.state !== "released", "ASSIGNMENT_RELEASED", "已释放登记不能续用，请创建新登记");
        requireValue(action === "user-release" || row.task_id === task.id && row.member_id === member.id, "ASSIGNMENT_OWNER", "仅本人可接续和完成登记；用户解除使用 user-release");
        requireValue(action === "resume" || action === "user-release" || row.lease === member.lease, "HANDOFF_REQUIRED", "接替后先核对旧写入停止，再 resume 登记");
        return row;
    });
    requireValue(new Set(rows.map(row => row.assignment_id)).size === rows.length, "INPUT", "targets 不能重复");
    const stopped = flag(input, "writes_stopped");
    if (action === "update" || action === "resume")
        requireValue(uuid(input.contract_revision, "contract_revision") === task.current_revision, "VERSION_CONFLICT", "续接/进度更新须依据当前合同");
    requireValue(action !== "update" || !stopped, "INPUT", "update 仅记录进展，停写释放请用 complete/release");
    if (action === "resume" || action === "release")
        requireValue(stopped, "HANDOFF_REQUIRED", "需确认范围停写且相关在途操作结束");
    if (action === "user-release")
        requireValue(flag(input, "user_authorized"), "USER_REQUIRED", "必须依据用户明确解除指示，并填写原因；解除登记不会终止旧命令");
    const changed = rows.map(row => {
        const scopes = action === "resume" ? scopePaths(row.workspace, JSON.parse(row.scopes).map(scope => scope.path)) : JSON.parse(row.scopes);
        if (action === "resume")
            checkScopes(store, scopes, row.assignment_id);
        const targetTask = row.task_id === task.id ? task : store.task(row.task_id);
        const next = { ...row, scopes: JSON.stringify(scopes), id: newId(), version: integer(row.version + 1, "version", 0), author, reason, created_at: new Date().toISOString(),
            state: action === "update" ? row.state : action === "resume" ? "active" : stopped || action === "user-release" ? "released" : "release-pending",
            stopped: action === "resume" ? 0 : stopped ? 1 : 0, lease: action === "resume" ? member.lease : row.lease,
            stage: input.stage === undefined ? row.stage : text(input.stage, "stage", 256),
            deliverable: input.deliverable === undefined ? row.deliverable : text(input.deliverable, "deliverable", 1024),
            basis: input.basis === undefined ? row.basis : text(input.basis, "basis", 1024),
            contract_revision: action === "update" || action === "resume" ? task.current_revision : row.contract_revision,
            blocked: input.blocked === undefined ? row.blocked : text(input.blocked, "blocked", 1024, true) };
        return assignmentView(save(store, targetTask, next, action === "resume" ? scopes : undefined));
    });
    return { assignments: changed, ...(action === "user-release" ? { notice: "仅解除协作登记，没有取消或停止任何旧进程" } : {}) };
}
/** 用户菜单清理不接替任何成员；世代/请求去重仍在持锁事务内核对。 */
export function releaseByUser(store, task, request) {
    const meta = store.guard(request, task, true);
    requireValue(request.user_action === true && object(request.assignment, "assignment").action === "user-release", "USER_REQUIRED", "此入口仅用于用户菜单解除登记");
    const id = uuid(request.request_id, "request_id");
    const fingerprint = `user-release:${digest(canonical(request.assignment))}`;
    const keys = [task.id, meta.generation, request.client, request.session_id, id];
    requireValue(!store.one("SELECT id FROM snapshots WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?", ...keys), "REQUEST_CONFLICT", "request_id 已用于快照");
    const prior = store.one("SELECT fingerprint,result FROM requests WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?", ...keys);
    if (prior) {
        requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "request_id 已用于其他操作");
        return JSON.parse(prior.result);
    }
    const author = JSON.stringify({ client: request.client, session_id: request.session_id, model: request.model, user_action: true });
    const result = { database_id: meta.database_id, generation: meta.generation, task_id: task.id,
        ...updateAssignment(store, task, request, undefined, author), request_id: id };
    store.run("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", ...keys, fingerprint, JSON.stringify(result));
    return result;
}
