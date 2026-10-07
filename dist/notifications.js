import { choice, requireValue, text } from "./protocol.js";
/** 通知目标保留成员 UUID；名称用于输入，接替不改变目标身份。 */
export function notificationFields(store, task, request) {
    const priority = choice(request.priority ?? "normal", "priority", ["normal", "urgent"]);
    const reason = priority === "urgent" ? text(request.reason, "reason", 1024) : request.reason === undefined ? "" : text(request.reason, "reason", 1024);
    const target = request.notify ?? "all";
    let ids;
    if (target !== "all") {
        requireValue(Array.isArray(target) && target.length > 0 && target.length <= 20, "INPUT", "notify 需要 all 或至多二十个模型名称");
        ids = [...new Set(target.map(value => {
                const name = text(value, "notify.name", 512);
                const member = store.one("SELECT id FROM members WHERE task_id=? AND name=?", task.id, name);
                requireValue(member, "NOT_FOUND", `通知对象尚未加入：${name}`);
                return member.id;
            }))];
    }
    const disabled = priority === "urgent" ? store.all("SELECT name FROM members WHERE task_id=? AND urgent_enabled=0 AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))", task.id, ids ? JSON.stringify(ids) : null, JSON.stringify(ids ?? [])).map(row => row.name) : [];
    return { priority, reason, audience: JSON.stringify(ids ?? "all"), notification: { queued: true, delivered: false, urgent_disabled: disabled } };
}
