import type { Store, Task } from "./database.ts";
import type { Member } from "./members.ts";
import type { Request } from "./protocol.ts";
import { newId, object, requireValue, text, uuid } from "./protocol.ts";

/** 用户指示的短职责与来源；普通板上意见不构成变更授权。 */
export function dutyInput(value: unknown): { text: string; source: string } {
  const data = object(value, "duty");
  return { text: text(data.text, "duty.text", 512, true), source: text(data.source, "duty.source", 1024) };
}

/** 成员职责与合同/推进状态独立；系统事件保存旧值、新值与用户来源。 */
export function setDuty(store: Store, task: Task, member: Member, value: { text: string; source: string }, author: string): Record<string, unknown> {
  if (value.text === member.duty) return { duty_unchanged: true, member_id: member.id, duty: member.duty, duty_revision: member.duty_revision };
  const revision = newId();
  const change = { member_id: member.id, name: member.name, before: member.duty, after: value.text, source: value.source, base_duty: member.duty_revision, duty_revision: revision };
  const event = store.event(task, "duty-changed", revision, JSON.stringify(change), author);
  store.run("UPDATE members SET duty=?,duty_revision=? WHERE id=?", value.text, revision, member.id);
  return { duty_change: change, event };
}

/** 用户可指定已加入成员职责，但必须核对该成员当前职责版本。 */
export function updateDuty(store: Store, task: Task, request: Request, member: Member, author: string): Record<string, unknown> {
  requireValue(request.preview !== true, "INPUT", "职责更新不支持 preview，请先查看成员概况");
  const input = object(request.duty, "duty");
  const target = input.member_id === undefined ? member : store.one<Member>("SELECT * FROM members WHERE task_id=? AND id=?", task.id, uuid(input.member_id, "duty.member_id"));
  requireValue(target, "NOT_FOUND", "职责目标成员未加入房间");
  requireValue(input.base_duty === target.duty_revision, "VERSION_CONFLICT", "成员职责已变化；首次使用 base_duty:null", { current_duty: target.duty_revision });
  return setDuty(store, task, target, dutyInput(input), author);
}

/** 邀请只带公开定位和用户已指定职责，收到用户粘贴后才能据此行动。 */
export function invitation(store: Store, task: Task, request: Request): Record<string, unknown> {
  const title = store.one<{ title: string }>("SELECT title FROM revisions WHERE id=?", task.current_revision)!.title;
  const duty = request.invite_duty === undefined ? undefined : text(request.invite_duty, "invite_duty", 512);
  const scope = request.invite_scope === undefined ? undefined : text(request.invite_scope, "invite_scope", 2048);
  const lines = [`请使用 collab open 加入主题“${title}”，task_id 为 ${task.id}。`,
    ...(duty ? [`我指定你的分工为：${duty}。请将此用户指示登记为成员职责；若原职责不同，明确说明变更。`] : ["先继承并查看当前职责；没有职责时先阅读，执行前再向我明确分工。"]),
    ...(scope ? [`我指定本次工作范围为：${scope}。写入前按实际文件登记范围。`] : []),
    "请读取当前合同、推进状态及与你职责有关的未解决意见；最近十条只是导航。按已有授权继续，无需确认收到或轮询等待。"];
  return { invitation: lines.join("\n"), task_id: task.id, title, contract_revision: task.current_revision };
}
