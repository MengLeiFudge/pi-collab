import { authorFor, requireMember } from "./members.js";
import { canonical, digest, requireValue, uuid } from "./protocol.js";
/** 普通写入和跨 Git/SQLite 的快照接续共用请求命名空间及去重规则。 */
export function beginWrite(store, request) {
    const task = store.task(uuid(request.task_id, "task_id"));
    const meta = store.guard(request, task, true);
    requireValue(request.project_id === undefined || request.project_id === task.project_id, "PROJECT", "任务不属于指定项目");
    const member = requireMember(store, task, request);
    const requestId = uuid(request.request_id, "request_id");
    const transport = new Set(["after", "window", "issues_after", "view", "max_bytes", "offset", "limit", "database_id", "generation", "client", "session_id", "request_id", "task_id", "project_id", "membership", "model", "delivered", "automatic"]);
    const business = Object.fromEntries(Object.entries(request).filter(([key]) => !transport.has(key)));
    const fingerprint = digest(canonical({ ...business, member_id: member.id }));
    const keys = [task.id, meta.generation, request.client, request.session_id, requestId];
    const intent = store.one("SELECT fingerprint FROM snapshots WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?", ...keys);
    requireValue(!intent || intent.fingerprint === fingerprint, "REQUEST_CONFLICT", "request_id 已用于不同的快照采集意图");
    const prior = store.one("SELECT fingerprint,result FROM requests WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?", ...keys);
    if (prior)
        requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "同一 request_id 的内容不同，请核对原提交结果后再决定");
    return { task, generation: meta.generation, requestId, fingerprint, memberId: member.id, author: authorFor(request, member), prior: prior ? JSON.parse(prior.result) : undefined };
}
/** 业务结果与去重记录同事务提交；快照的 Git 引用在此之前已经固定。 */
export function finishWrite(store, request, context, value) {
    const result = { database_id: store.metadata().database_id, generation: context.generation, project_id: context.task.project_id,
        task_id: context.task.id, ...value, member_id: context.memberId, request_id: context.requestId };
    if (request.preview !== true)
        store.run("INSERT INTO requests VALUES(?,?,?,?,?,?,?)", context.task.id, context.generation, request.client, request.session_id, context.requestId, context.fingerprint, JSON.stringify(result));
    return result;
}
