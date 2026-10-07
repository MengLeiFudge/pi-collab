import { concurrentRoom } from "./rooms.js";
import { registerProject } from "./routing.js";
import { selectedModel } from "./members.js";
import { canonical, choice, digest, newId, requireValue, text, uuid } from "./protocol.js";
/** 建房与加入由调用方放在同一写事务；无任务 ID 的请求也有稳定去重键。 */
export function createRoom(store, request, location) {
    const meta = store.gate();
    requireValue(request.database_id === meta.database_id && request.generation === meta.generation, "GENERATION_CHANGED", "建房前先取得 prepare_creation 返回的数据库身份；不能将旧建房请求改绑新世代");
    const requestId = uuid(request.request_id, "request_id");
    const model = selectedModel(request);
    const title = text(request.title, "title", 512);
    const body = text(request.body, "body", 2 * 1024 * 1024, true);
    const summary = text(request.summary ?? title, "summary", 2048);
    const status = choice(request.status ?? "in-progress", "status", ["in-progress", "completed", "blocked", "paused"]);
    const fingerprint = digest(canonical({ location, title, body, summary, status, model,
        duty: request.duty, topic_create: request.topic_create, known_topics: request.known_topics }));
    const keys = [meta.generation, request.client, request.session_id, requestId];
    const prior = store.one("SELECT * FROM creation_requests WHERE generation=? AND client=? AND session_id=? AND request_id=?", ...keys);
    if (prior) {
        requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "建房 request_id 已用于其他内容");
        const task = store.task(prior.task_id);
        store.guard(request, task, true);
        return { task, created: !!prior.created };
    }
    const projectId = registerProject(store, location);
    const existing = concurrentRoom(store, projectId, request);
    const id = existing ?? newId();
    if (!existing) {
        const revisionId = newId();
        const author = JSON.stringify({ client: request.client, session_id: request.session_id, model });
        store.run("INSERT INTO tasks VALUES(?,?,?,0)", id, projectId, revisionId);
        const task = store.task(id);
        const event = store.event(task, "created", revisionId, summary, author);
        store.run("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?)", revisionId, id, 1, event.seq, title, summary, status, body, author, new Date().toISOString());
    }
    store.run("INSERT INTO creation_requests VALUES(?,?,?,?,?,?,?)", ...keys, fingerprint, id, existing ? 0 : 1);
    return { task: store.task(id), created: !existing };
}
