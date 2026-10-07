import { inboxText } from "./protocol.js";
/** Pi 的可读结果不重复协议凭证；完整结果仍存 details，CLI 不受影响。 */
export function resultText(result) {
    if (!result.ok)
        return JSON.stringify(result);
    if (typeof result.invitation === "string")
        return result.invitation;
    if (result.view === "content")
        return inboxText(result);
    if (!result.room || !result.task)
        return JSON.stringify(result);
    const task = result.task;
    const room = result.room;
    const recent = result.recent;
    const counts = result.counts;
    const lines = [
        `${result.created ? "已创建" : result.membership ? "已加入" : "房间"}：${task.title}；身份 ${room.membership_status}`,
        `成员 ${room.member_count}：${room.members.map(item => `${item.name}（${item.duty || "职责未指定"}；成员 ${item.id}；职责版本 ${item.duty_revision ?? "null"}）`).join("、")}${room.members_after ? `；更多：open input.members_after=${room.members_after}` : ""}`,
        `消息 ${room.messages.total} 条（${room.messages.first ?? 0}..${room.messages.last ?? 0}）；忙碌紧急通知${room.urgent_enabled ? "开启" : "关闭"}`,
        `合同 v${task.version}：show ${task.revision_id}；未解决意见 ${counts.open_issues}（read view:index）。`,
    ];
    if (result.duty_change)
        lines.push(`职责变更：${JSON.stringify(result.duty_change)}`);
    if (room.assignments.length)
        lines.push(`写入登记：${room.assignments.map(item => `${item.state} ${item.count}`).join("、")}；read view:assignments 查看并处理待释放范围。`);
    if (result.progress)
        lines.push(`推进状态：${JSON.stringify(result.progress)}`);
    if (room.last_query)
        lines.push(`上次查询：${JSON.stringify(room.last_query)}`);
    lines.push("最近消息摘要（正文用 read latest:10 或 show 对象）：", ...recent.messages.map(item => `#${item.chat_no} ${item.summary}；show ${item.id}`));
    if (result.request_id)
        lines.push(`request_id：${result.request_id}`);
    if (result.warnings)
        lines.push(`告警：${JSON.stringify(result.warnings)}`);
    return lines.join("\n");
}
