import { dutyInput, setDuty } from "./duties.js";
import { bindSession, findSession, sessionName } from "./identity.js";
import { canonical, digest, newId, object, requireValue, text, uuid } from "./protocol.js";
/** 原生 Pi 适配器注入模型信息；缺失时不生成临时昵称。 */
export function selectedModel(request) {
    requireValue(request.model && typeof request.model === "object" && !Array.isArray(request.model), "MODEL_UNAVAILABLE", "Pi 尚未提供选中模型，不能加入或发言");
    const value = request.model;
    requireValue([value.name, value.provider, value.id].every(item => typeof item === "string" && item.trim().length > 0), "MODEL_UNAVAILABLE", "选中模型的 name/provider/id 不完整");
    return { name: text(value.name, "model.name", 512), provider: text(value.provider, "model.provider", 256), id: text(value.id, "model.id", 512) };
}
/** 校验客户端凭证形状；只读调用可以没有成员凭证。 */
export function membership(value) {
    if (value === undefined)
        return undefined;
    const data = object(value, "membership");
    return { member_id: uuid(data.member_id, "membership.member_id"), lease: uuid(data.lease, "membership.lease") };
}
/** 同一事务内检查会话、世代与接替凭证；失效会话仍可只读查询。 */
export function currentMember(store, task, request) {
    const claim = membership(request.membership);
    if (!claim)
        return undefined;
    const session = findSession(store.db, task.id, request.session_id);
    const member = store.one("SELECT * FROM members WHERE id=? AND task_id=?", claim.member_id, task.id);
    if (!member || session?.member_id !== member.id || member.kind !== "pi" || member.owner_client !== request.client || member.owner_session !== request.session_id ||
        member.lease !== claim.lease || member.claimed_generation !== store.metadata().generation)
        return undefined;
    member.short_id = session.short_id;
    return member;
}
/** 业务写入在请求去重之前检查凭证；旧请求不能绕过接替。 */
export function requireMember(store, task, request) {
    selectedModel(request);
    requireValue(request.membership !== undefined, "JOIN_REQUIRED", "请先用 Pi collab open 加入房间");
    const member = currentMember(store, task, request);
    requireValue(member, "SUPERSEDED", "会话的成员凭证已失效；可只读查询，明确重新加入才能继续写入");
    return member;
}
/** 同一会话复用成员；有效凭证下切换模型保留 lease、职责和阅读位置。 */
export function joinRoom(store, task, request, cursor) {
    const model = selectedModel(request);
    const requestId = uuid(request.request_id, "request_id");
    const meta = store.guard(request, task, false);
    const duty = request.duty === undefined ? undefined : dutyInput(request.duty);
    const fingerprint = `join-v1:${digest(canonical({ task_id: task.id, model, ...(duty ? { duty } : {}) }))}`;
    const prior = store.one("SELECT fingerprint,result FROM requests WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?", task.id, meta.generation, request.client, request.session_id, requestId);
    if (prior) {
        requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "加入 request_id 已用于不同操作");
        const result = JSON.parse(prior.result);
        const member = currentMember(store, task, { ...request, membership: result.membership });
        requireValue(member, "SUPERSEDED", "原加入请求的凭证已经失效，旧请求不能再次取得持有权");
        return { ...result, member_name: member.name, short_id: member.short_id };
    }
    const session = findSession(store.db, task.id, request.session_id);
    const before = session ? store.one("SELECT * FROM members WHERE id=? AND task_id=?", session.member_id, task.id) : undefined;
    const id = before?.id ?? newId();
    const active = currentMember(store, task, request);
    const lease = active?.id === id ? active.lease : newId();
    const now = new Date().toISOString();
    if (!before) {
        // 占位名称仅在当前事务内存在；先建成员以满足会话归属的外键约束。
        store.run("INSERT INTO members(id,task_id,name,model,joined_at,updated_at) VALUES(?,?,?,?,?,?)", id, task.id, id, JSON.stringify(model), now, now);
    }
    const bound = bindSession(store.db, task.id, request.session_id, id);
    const name = sessionName(model.name, bound.short_id);
    store.run("UPDATE members SET name=?,model=?,owner_client=?,owner_session=?,lease=?,claimed_generation=?,updated_at=? WHERE id=?", name, JSON.stringify(model), request.client, request.session_id, lease, meta.generation, now, id);
    const joinedMember = store.one("SELECT * FROM members WHERE id=?", id);
    joinedMember.short_id = bound.short_id;
    const change = duty ? setDuty(store, task, joinedMember, duty, authorFor(request, joinedMember)) : undefined;
    const position = active?.id === id && request.after !== undefined ? { ...cursor, after: store.checkAnchor(task, request.after) } : cursor;
    const result = { membership: { member_id: id, lease }, cursor: position, member_name: name, short_id: bound.short_id, ...(change ? { duty_change: change.duty_change } : {}) };
    store.run("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", task.id, meta.generation, request.client, request.session_id, requestId, fingerprint, JSON.stringify(result));
    return result;
}
/** 作者保存写入时的模型和会话显示名，之后切换模型不会改写历史发言。 */
export function authorFor(request, member) {
    const model = selectedModel(request);
    return JSON.stringify({ client: request.client, session_id: request.session_id, member_id: member.id, model,
        name: sessionName(model.name, member.short_id ?? request.session_id.slice(0, 8)) });
}
/** 旧作者记录按原会话补显示名，外部作者保留独立名称。 */
export function publicAuthor(raw) {
    const author = JSON.parse(raw);
    return { ...author, name: author.kind === "external" ? author.name : author.name ?? sessionName(author.model?.name ?? "未知模型", author.session_id.slice(0, 8)) };
}
/** 成员列表不代表在线人数；分页避免大量历史成员占满一次工具输出。 */
export function roomInfo(store, task, request) {
    const after = request.members_after === undefined ? "" : uuid(request.members_after, "members_after");
    const rows = store.all("SELECT m.*,s.session_id,s.short_id FROM members m LEFT JOIN member_sessions s ON s.member_id=m.id WHERE m.task_id=? AND m.id>? ORDER BY m.id LIMIT 21", task.id, after);
    const members = rows.slice(0, 20).map(row => ({ id: row.id, name: row.name, session_id: row.session_id, short_id: row.short_id, model: JSON.parse(row.model), has_holder: row.lease !== null, duty: row.duty, duty_revision: row.duty_revision }));
    const total = store.one("SELECT count(*) AS total,min(chat_no) AS first,max(chat_no) AS last FROM messages WHERE task_id=?", task.id);
    const claim = membership(request.membership);
    const member = currentMember(store, task, request);
    const viewed = member ? store.one("SELECT * FROM member_views WHERE member_id=?", member.id) : undefined;
    return {
        member_count: store.one("SELECT count(*) AS n FROM members WHERE task_id=?", task.id).n,
        members, members_after: rows.length > 20 ? members.at(-1).id : null,
        messages: total, urgent_enabled: member ? !!member.urgent_enabled : null, membership_status: member ? "active" : claim ? "superseded" : "read-only",
        assignments: store.all("SELECT r.state,count(*) AS count FROM assignments a JOIN assignment_revisions r ON r.id=a.current_revision WHERE a.task_id=? AND r.state!='released' GROUP BY r.state", task.id),
        last_query: viewed ? { ...viewed, query: JSON.parse(viewed.query), messages: JSON.parse(viewed.messages), delivery_confirmed: false } : null,
    };
}
/** 查看记录仅供跨会话参考，不产生事件，也不决定自动收件是否已交付。 */
export function recordQuery(store, task, request, query, messages) {
    const member = currentMember(store, task, request);
    if (!member)
        return;
    store.run("INSERT INTO member_views(member_id,generation,query,messages,queried_at) VALUES(?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET generation=excluded.generation,query=excluded.query,messages=excluded.messages,queried_at=excluded.queried_at", member.id, store.metadata().generation, JSON.stringify(query), JSON.stringify(messages), new Date().toISOString());
}
