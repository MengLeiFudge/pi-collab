import { showAssignment } from "./assignments.ts";
import type { Store, Task } from "./database.ts";
import { anchor, diffPreview, documentDiff, excerpt, integer, requireValue, uuid } from "./protocol.ts";
import type { InboxMessage, InboxResult, MessageStats, Request, Window } from "./protocol.ts";
import type { SQLInputValue } from "node:sqlite";
import { snapshotView } from "./snapshot.ts";
import type { SnapshotRow } from "./snapshot.ts";
import { currentMember, publicAuthor } from "./members.ts";

/** 不可变事件为正文投递提供排序和来源；作者必须保持原始会话身份。 */
interface Event {
  id: string; seq: number; kind: string; object_id: string; summary: string; author: string;
}

/** 从不可变事件渲染当时的职责与指示来源，不借用成员后来修改的职责。 */
function dutyNotice(raw: string): { summary: string; body: string } {
  const change = JSON.parse(raw) as { name: string; before: string; after: string; source: string };
  const before = change.before || "未指定";
  const after = change.after || "未指定";
  return {
    summary: `${excerpt(change.name, 64)} 职责：${excerpt(before, 40)} → ${excerpt(after, 40)}`,
    body: `${change.name} 职责：${before} → ${after}\n来源：${change.source}`,
  };
}

/** 计数与正文共用自身过滤及已交付集合；查看意见原文不屏蔽后来 resolved 事件。 */
export function inboxFilter(store: Store, task: Task, request: Request, after: number, upper: number): { sql: string; values: SQLInputValue[] } {
  const values: SQLInputValue[] = [task.id, after, upper, request.client, request.session_id];
  let sql = "task_id=? AND seq>? AND seq<=? AND NOT (json_extract(author,'$.client')=? AND json_extract(author,'$.session_id')=?)";
  const member = currentMember(store, task, request);
  if (member) { sql += " AND coalesce(json_extract(author,'$.member_id'),'')<>?"; values.push(member.id); }
  if (request.delivered !== undefined) {
    requireValue(Array.isArray(request.delivered) && request.delivered.length <= 32768, "INPUT", "delivered 需要不超过 32768 个已交付消息 UUID");
    const ids = request.delivered.map(value => uuid(value, "delivered"));
    sql += " AND (kind<>'posted' OR object_id NOT IN (SELECT value FROM json_each(?)))";
    values.push(JSON.stringify(ids));
  }
  return { sql, values };
}

/** 统计房间消息而非系统事件；历史翻阅和紧急跳读不改变水位线计数。 */
export function messageStats(store: Store, task: Task, after: number): MessageStats {
  const row = store.one<{ total: number; unread: number; title: string }>(
    "SELECT count(*) AS total,coalesce(sum(event_seq>?),0) AS unread,(SELECT title FROM revisions WHERE id=?) AS title FROM messages WHERE task_id=?", after, task.current_revision, task.id)!;
  return { ...row, after, upper: task.event_seq };
}

/** 按固定快照合并正文；批次确认上界，预算外内容通过明确入口按需展开。 */
export function readInbox(store: Store, task: Task, request: Request, window: Window): InboxResult {
  const after = request.after === undefined ? window.upper : anchor(request.after);
  const filter = inboxFilter(store, task, request, after.seq, window.upper.seq);
  const urgentOnly = request.urgent_only === true;
  requireValue(!urgentOnly || request.automatic === true, "INPUT", "urgent_only 只用于插件自动收件");
  let wait = 0;
  let eligible = true;
  if (request.automatic === true) {
    const member = currentMember(store, task, request)!;
    const target = "kind='posted' AND EXISTS (SELECT 1 FROM messages m WHERE m.id=events.object_id AND (m.audience='\"all\"' OR EXISTS (SELECT 1 FROM json_each(m.audience) WHERE value=?)))";
    const notice = store.one<{ n: number; urgent: number; first: string | null; last: string | null }>(
      `SELECT count(*) AS n,coalesce(sum(EXISTS(SELECT 1 FROM messages m WHERE m.id=events.object_id AND m.priority='urgent')),0) AS urgent,min(created_at) AS first,max(created_at) AS last FROM events WHERE ${filter.sql} AND ${target}`,
      ...filter.values, member.id)!;
    eligible = notice.n > 0;
    if (urgentOnly) {
      filter.sql += ` AND ${target} AND EXISTS (SELECT 1 FROM messages m WHERE m.id=events.object_id AND m.priority='urgent')`;
      filter.values.push(member.id);
      eligible = !!member.urgent_enabled && notice.urgent > 0;
    } else if (eligible && !notice.urgent) wait = Math.max(0, Math.min(Date.parse(notice.last!) + 2000, Date.parse(notice.first!) + 10000) - Date.now());
  }
  const orderValues: SQLInputValue[] = [];
  let order = "seq";
  if (request.automatic === true) {
    order = "EXISTS(SELECT 1 FROM messages m WHERE m.id=events.object_id AND m.priority='urgent' AND (m.audience='\"all\"' OR EXISTS(SELECT 1 FROM json_each(m.audience) WHERE value=?))) DESC,(kind='posted') DESC,seq";
    orderValues.push(currentMember(store, task, request)!.id);
  }
  const total = eligible && !wait ? store.one<{ n: number }>(`SELECT count(*) AS n FROM events WHERE ${filter.sql}`, ...filter.values)!.n : 0;
  const events = total ? store.all<Event>(`SELECT * FROM events WHERE ${filter.sql} ORDER BY ${order} LIMIT 10`, ...filter.values, ...orderValues) : [];
  const result: InboxResult = {
    view: "content", database_id: window.database_id, generation: window.generation, task_id: task.id,
    messages: [], total_events: total, omitted_events: total,
    next: { database_id: window.database_id, generation: window.generation, task_id: task.id, after: urgentOnly || request.automatic && (!eligible || wait) ? after : window.upper },
    urgent_only: urgentOnly, wait_ms: wait,
    history: { after, window, view: "index" },
  };
  result.display_stats = messageStats(store, task, result.next.after.seq);
  const budget = integer(request.max_bytes, "max_bytes", 12 * 1024, 64 * 1024);
  requireValue(budget >= 4096, "INPUT", "max_bytes 至少为 4096");
  // 显示元数据不占模型正文预算，保持已有批次的正文截断边界。
  const bytes = (): number => {
    const { display_stats: _stats, ...content } = result;
    return Buffer.byteLength(JSON.stringify({ ok: true, ...content }));
  };
  // 先为所有可列事件保留来源和入口，再把剩余字节分配给正文，避免首条吃掉整批。
  for (const event of events) {
    let summary = event.summary;
    if (event.kind === "resolved") {
      const issue = store.one<{ summary: string }>("SELECT summary FROM messages WHERE task_id=? AND id=?", task.id, event.object_id);
      requireValue(issue, "NOT_FOUND", "事件对应的意见不存在");
      summary = issue.summary;
    } else if (event.kind === "duty-changed") summary = dutyNotice(event.summary).summary;
    const item: InboxMessage = {
      event_id: event.id, seq: event.seq, kind: event.kind, object_id: event.object_id,
      author: publicAuthor(event.author), summary: excerpt(summary, 160), body: "", truncated: true,
      show: { object_id: event.object_id },
    };
    result.messages.push(item);
    result.omitted_events--;
    if (bytes() > budget / 2) { result.messages.pop(); result.omitted_events++; break; }
  }
  for (let i = 0; i < result.messages.length; i++) {
    const item = result.messages[i];
    let body: string;
    let diff: string | undefined;
    let documentHeader = "";
    if (item.kind === "posted") {
      const message = store.one<{ body: string; chat_no: number; reply_to: string | null; reply_revision: string | null; priority: string; reason: string }>("SELECT body,chat_no,reply_to,reply_revision,priority,reason FROM messages WHERE task_id=? AND id=?", task.id, item.object_id);
      requireValue(message, "NOT_FOUND", "事件对应的消息不存在");
      item.chat_no = message.chat_no;
      item.priority = message.priority;
      const reply = message.reply_to ?? message.reply_revision;
      body = (message.priority === "urgent" ? `紧急原因：${message.reason}\n` : "") + (reply ? `回复${message.reply_revision ? "文档版本" : "消息"}：${reply}\n` : "") + message.body;
    } else if (item.kind === "assigned") {
      const assignment = showAssignment(store, task, item.object_id);
      requireValue(assignment, "NOT_FOUND", "分工修订不存在");
      const member = store.one<{ name: string }>("SELECT name FROM members WHERE id=? AND task_id=?", assignment.member_id, task.id);
      requireValue(member, "NOT_FOUND", "分工所属成员不存在");
      const state = assignment.state === "active" ? "占用中" : assignment.state === "release-pending" ? "待释放，尚未确认停写" :
        assignment.stopped ? "已释放，已确认停写" : "已由用户解除，未确认停写";
      body = `${member.name} 的写入范围：${assignment.scopes.join("、")}（阶段：${assignment.stage}；${state}）\n原因：${assignment.reason}`;
    } else if (item.kind === "duty-changed") {
      body = dutyNotice(events[i].summary).body;
      item.show.object_id = item.event_id;
    } else if (item.kind === "snapshotted") {
      const snapshot = store.one<SnapshotRow>("SELECT * FROM snapshots WHERE id=? AND task_id=?", item.object_id, task.id);
      requireValue(snapshot, "NOT_FOUND", "快照登记不存在");
      body = JSON.stringify(snapshotView(snapshot));
    } else if (item.kind === "progressed") {
      const progress = store.one<{ state: string; contract_revision: string }>("SELECT state,contract_revision FROM progress_revisions WHERE id=? AND task_id=?", item.object_id, task.id);
      requireValue(progress, "NOT_FOUND", "推进状态版本不存在");
      body = `依据合同：${progress.contract_revision}\n${progress.state}`;
    } else if (item.kind === "resolved") {
      body = events[i].summary;
    } else {
      requireValue(item.kind === "created" || item.kind === "updated", "EVENT", "不支持的协作事件类型");
      const current = store.one<{ id: string; body: string; version: number; title: string; status: string }>(
        "SELECT id,body,version,title,status FROM revisions WHERE task_id=? AND id=?", task.id, item.object_id,
      );
      requireValue(current, "NOT_FOUND", "事件对应的文档版本不存在");
      body = current.body;
      if (item.kind === "updated") {
        const previous = store.one<{ id: string; body: string }>("SELECT id,body FROM revisions WHERE task_id=? AND version=?", task.id, current.version - 1);
        requireValue(previous, "NOT_FOUND", "文档差异的基础版本不存在");
        diff = documentDiff(previous, current);
        body = diff;
        item.show.compare_to = previous.id;
      }
      documentHeader = `文档：${current.title}；版本 ${current.version}；状态 ${current.status}\n`;
      body = documentHeader + body;
    }
    const allowance = Math.max(0, Math.floor((budget - bytes() - 512) / (result.messages.length - i)));
    const preview = diff !== undefined && Buffer.byteLength(JSON.stringify(body)) - 2 > allowance;
    if (preview) body = documentHeader + diffPreview(diff!);
    // JSON 转义和代理对都计入预算；二分查找可容纳的前缀，截断不会自动续发。
    let low = 0;
    let high = body.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(body.slice(0, mid))) - 2 <= allowance) low = mid;
      else high = mid - 1;
    }
    if (low > 0 && low < body.length && /[\uDC00-\uDFFF]/.test(body[low])) low--;
    item.body = body.slice(0, low);
    item.truncated = preview || low < body.length;
  }
  requireValue(bytes() <= budget, "OUTPUT_BUDGET", "合并内容元数据超过预算");
  return result;
}
