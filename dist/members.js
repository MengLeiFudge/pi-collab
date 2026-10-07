import { dutyInput, setDuty } from "./duties.js";
import { pendAssignments } from "./assignments.js";
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
    const member = store.one("SELECT * FROM members WHERE id=? AND task_id=?", claim.member_id, task.id);
    if (!member || member.owner_client !== request.client || member.owner_session !== request.session_id ||
        member.lease !== claim.lease || member.claimed_generation !== store.metadata().generation)
        return undefined;
    if (request.model !== undefined && selectedModel(request).name !== member.name)
        return undefined;
    return member;
}
/** 业务写入在请求去重之前检查凭证；旧请求不能绕过接替。 */
export function requireMember(store, task, request) {
    selectedModel(request);
    requireValue(request.membership !== undefined, "JOIN_REQUIRED", "请先用 Pi collab open 加入房间");
    const member = currentMember(store, task, request);
    requireValue(member, "SUPERSEDED", "成员凭证已被接替或选中模型已变化；可只读查询，明确重新加入才能继续写入");
    return member;
}
/** 明确加入才取得持有权；请求记录与成员变更在调用方同一个写事务内提交。 */
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
        requireValue(currentMember(store, task, { ...request, membership: result.membership }), "SUPERSEDED", "原加入请求的凭证已经失效，旧请求不能再次接替");
        return result;
    }
    const before = store.one("SELECT * FROM members WHERE task_id=? AND name=?", task.id, model.name);
    const id = before?.id ?? newId();
    const lease = newId();
    const now = new Date().toISOString();
    // 切换模型只释放本会话仍持有的旧槽位，不能解除其他会话后来取得的身份。
    const previous = membership(request.membership);
    if (previous && previous.member_id !== id) {
        if (currentMember(store, task, { ...request, model: undefined }))
            pendAssignments(store, task, JSON.stringify({ client: request.client, session_id: request.session_id, model }), previous.member_id);
        store.run("UPDATE members SET owner_client=NULL,owner_session=NULL,lease=NULL,claimed_generation=NULL,updated_at=? WHERE task_id=? AND id=? AND owner_client=? AND owner_session=? AND lease=?", now, task.id, previous.member_id, request.client, request.session_id, previous.lease);
    }
    if (before) {
        store.run("UPDATE members SET model=?,owner_client=?,owner_session=?,lease=?,claimed_generation=?,updated_at=? WHERE id=?", JSON.stringify(model), request.client, request.session_id, lease, meta.generation, now, id);
    }
    else {
        store.run("INSERT INTO members(id,task_id,name,model,owner_client,owner_session,lease,claimed_generation,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, task.id, model.name, JSON.stringify(model), request.client, request.session_id, lease, meta.generation, now, now);
    }
    const joinedMember = store.one("SELECT * FROM members WHERE id=?", id);
    const change = duty ? setDuty(store, task, joinedMember, duty, authorFor(request, joinedMember)) : undefined;
    const result = { membership: { member_id: id, lease }, cursor, ...(change ? { duty_change: change.duty_change } : {}) };
    store.run("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", task.id, meta.generation, request.client, request.session_id, requestId, fingerprint, JSON.stringify(result));
    return result;
}
/** 作者保留原传输身份并附加当时选中模型；接替不会改写历史发言。 */
export function authorFor(request, member) {
    return JSON.stringify({ client: request.client, session_id: request.session_id, member_id: member.id, model: selectedModel(request) });
}
/** 作者显示名取写入时保存的模型名，接替不改变历史显示。 */
export function publicAuthor(raw) {
    const author = JSON.parse(raw);
    return { ...author, name: author.model.name };
}
/** 成员列表不代表在线人数；分页避免大量历史成员占满一次工具输出。 */
export function roomInfo(store, task, request) {
    const after = request.members_after === undefined ? "" : uuid(request.members_after, "members_after");
    const rows = store.all("SELECT * FROM members WHERE task_id=? AND id>? ORDER BY id LIMIT 21", task.id, after);
    const members = rows.slice(0, 20).map(row => ({ id: row.id, name: row.name, model: JSON.parse(row.model), has_holder: row.lease !== null, duty: row.duty, duty_revision: row.duty_revision }));
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
