import { Store } from "./database.ts";
import type { Task } from "./database.ts";
import { bridgeConfig } from "./bridge-config.ts";
import type { BridgeConfig } from "./bridge-config.ts";
import { authorFor, requireMember } from "./members.ts";
import { canonical, choice, digest, integer, newId, object, requireValue, text, uuid } from "./protocol.ts";
import type { Request } from "./protocol.ts";
import { notifyCommitted } from "./signals.ts";

/** 原文只保留七天；来源标识、批次、摘要和决定审计长期保留。 */
const retention = 7 * 86400_000;

/** 不可变题面及其单次决定状态。 */
interface Decision {
  id: string; task_id: string; bridge_id: string; generation: string; contract_revision: string;
  batch_id: string; member_id: string; question: string; options: string; content_hash: string;
  expires_at: number; state: string; reply: string | null;
}

/** 每次数据库请求校验真实配置绑定；不信任 HTTP 提供的房间/作者字段。 */
function boundTask(store: Store, config: BridgeConfig): Task {
  const meta = store.gate();
  requireValue(meta.database_id === config.database_id && meta.generation === config.generation, "GENERATION_CHANGED", "桥接绑定已过期，请本地重新配置");
  return store.task(config.task_id);
}

/** 外部成员从配置确定身份，没有 Pi model 或持有权。 */
function externalMember(store: Store, task: Task, config: BridgeConfig): { id: string; author: string } {
  const name = `QQ ${config.bot_id} / ${config.bridge_id}`;
  let member = store.one<{ id: string; kind: string }>("SELECT id,kind FROM members WHERE task_id=? AND name=?", task.id, name);
  if (!member) {
    const id = newId(), now = new Date().toISOString();
    store.run("INSERT INTO members(id,task_id,name,model,joined_at,updated_at,kind) VALUES(?,?,?,'null',?,?,'external')", id, task.id, name, now, now);
    member = { id, kind: "external" };
  }
  requireValue(member.kind === "external", "IDENTITY", "桥接名称已被Pi成员占用");
  return { id: member.id, author: JSON.stringify({ client: "bridge", session_id: config.bridge_id, member_id: member.id, kind: "external", name, external_id: config.bridge_id }) };
}

/** 只有批次摘要与经过核验的主人决定进入普通投递流。 */
function publish(store: Store, task: Task, config: BridgeConfig, body: string, audience: string = '"all"'): string {
  const member = externalMember(store, task, config);
  const id = newId();
  const brief = body.slice(0, 160);
  const event = store.event(task, "posted", id, brief, member.author);
  const chatNo = store.one<{ n: number }>("SELECT coalesce(max(chat_no),0)+1 AS n FROM messages WHERE task_id=?", task.id)!.n;
  requireValue(Number.isSafeInteger(chatNo), "SEQUENCE_LIMIT", "聊天序号超限");
  store.run("INSERT INTO messages(id,task_id,kind,body,summary,author,evidence,event_seq,created_at,chat_no,member_id,audience) VALUES(?,?,'message',?,?,?,'[]',?,?,?,?,?)",
    id, task.id, body, brief, member.author, event.seq, new Date().toISOString(), chatNo, member.id, audience);
  return id;
}

/** 群组原文和摘要原子落库；同来源不能换批次重复唤醒。 */
function receiveBatch(store: Store, task: Task, config: BridgeConfig, input: Record<string, unknown>): Record<string, unknown> {
  const id = uuid(input.batch_id, "batch_id");
  const fingerprint = digest(canonical(input));
  const prior = store.one<{ fingerprint: string; message_id: string }>("SELECT fingerprint,message_id FROM bridge_batches WHERE id=? AND bridge_id=? AND generation=?", id, config.bridge_id, config.generation);
  if (prior) {
    requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "batch_id 已用于不同内容");
    return { batch_id: id, message_id: prior.message_id };
  }
  const group = text(input.group_id, "group_id", 64);
  requireValue(/^\d+$/.test(group), "INPUT", "group_id 需要QQ群号");
  requireValue(input.platform_id === config.platform_id && input.bot_id === config.bot_id, "IDENTITY", "平台或机器人不匹配");
  const summary = text(input.summary, "summary", 8192);
  requireValue(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 50, "INPUT", "每批需要1–50条来源");
  const now = Date.now();
  const items = input.items.map(item => {
    const value = object(item, "item");
    const received = integer(value.received_at, "received_at", 0);
    requireValue(received > now - retention && received <= now + 60_000, "EXPIRED", "来源已超过七天或时间无效");
    const sender = text(value.sender_id, "sender_id", 64);
    requireValue(/^\d+$/.test(sender) && sender !== config.bot_id, "IDENTITY", "来源发送者无效");
    return { message_id: text(value.message_id, "message_id", 128), sender_id: sender, received_at: received, body: text(value.body, "body", 8192) };
  });
  requireValue(new Set(items.map(item => item.message_id)).size === items.length, "INPUT", "批次内来源重复");
  for (const item of items) requireValue(!store.one("SELECT batch_id FROM bridge_sources WHERE bridge_id=? AND platform_id=? AND group_id=? AND message_id=?", config.bridge_id, config.platform_id, group, item.message_id), "SOURCE_CONFLICT", "来源已在其他批次发布");
  const used = store.one<{ n: number }>("SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS n FROM bridge_sources WHERE body IS NOT NULL")!.n;
  requireValue(used + items.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) <= config.max_raw_bytes, "CAPACITY", "原文存储已满，未接收此批次");
  const message = publish(store, task, config, `QQ 群 ${group} 需求摘要（未经主人批准执行）\n批次 ${id}；${items.length} 条来源，原文按需 read bridge 查询。\n${summary}`);
  store.run("INSERT INTO bridge_batches VALUES(?,?,?,?,?,?,?,?)", id, config.bridge_id, task.id, config.generation, group, fingerprint, message, new Date().toISOString());
  for (const item of items) store.run("INSERT INTO bridge_sources VALUES(?,?,?,?,?,?,?,?)", config.bridge_id, config.platform_id, group, item.message_id, id, item.sender_id, item.received_at, item.body);
  return { batch_id: id, message_id: message };
}

/** 主人身份来自受信插件的私聊事件，决定目标仅从不可变记录取得。 */
function receiveDecision(store: Store, task: Task, config: BridgeConfig, input: Record<string, unknown>): Record<string, unknown> {
  const id = uuid(input.decision_id, "decision_id");
  const event = object(input.event, "event");
  requireValue(event.platform_id === config.platform_id && event.bot_id === config.bot_id && event.sender_id === config.owner_id && event.message_type === "private" && !event.group_id, "IDENTITY", "仅接受指定主人本人的私聊事件");
  const source = text(event.message_id, "event.message_id", 128);
  const decision = store.one<Decision>("SELECT * FROM bridge_decisions WHERE id=? AND bridge_id=? AND task_id=? AND generation=?", id, config.bridge_id, task.id, config.generation);
  requireValue(decision, "NOT_FOUND", "决定不存在");
  const option = text(input.option, "option", 32);
  const options = JSON.parse(decision.options) as Record<string, string>;
  requireValue(Object.hasOwn(options, option), "INPUT", "决定选项不存在");
  const raw = text(event.body, "event.body", 256).trim();
  requireValue(raw === `确认 ${id} ${option}`, "INPUT", "确认原文必须完整包含决定ID与选项");
  if (decision.state === "answered") {
    requireValue(JSON.parse(decision.reply!).option === option, "DECISION_CONFLICT", "决定已回答其他选项，需新建决定");
    return { decision_id: id, state: "answered", duplicate: true };
  }
  requireValue(decision.state === "pending" && decision.expires_at > Date.now() && decision.contract_revision === task.current_revision, "EXPIRED", "决定已取消、过期或合同已变化");
  const reply = { option, sender_id: config.owner_id, platform_id: config.platform_id, bot_id: config.bot_id, message_id: source, body: raw, received_at: new Date().toISOString(), content_hash: decision.content_hash };
  store.run("UPDATE bridge_decisions SET state='answered',reply=? WHERE id=?", JSON.stringify(reply), id);
  const message = publish(store, task, config, `主人私聊决定 ${id}\n题面：${decision.question}\n选项：${option} ${options[option]}\n合同：${decision.contract_revision}\n内容哈希：${decision.content_hash}\n来源QQ：${config.owner_id}；消息：${source}\n执行前仍须核对本会话授权和范围。`, JSON.stringify([decision.member_id]));
  return { decision_id: id, state: "answered", message_id: message };
}

/** HTTP 的受限业务入口：配置由本地文件读取，不提供任意 collab 调度。 */
export function executeBridge(value: unknown): Record<string, unknown> {
  const input = object(value, "bridge request");
  const config = bridgeConfig();
  requireValue(config, "CONFIG", "桥接尚未配置");
  requireValue(input.config_digest === digest(canonical(config)), "CONFIG", "桥接配置已变化，请重新加载Pi扩展");
  requireValue(input.bridge_id === config.bridge_id && input.database_id === config.database_id && input.generation === config.generation && input.task_id === config.task_id, "GENERATION_CHANGED", "请求绑定与当前配置不一致");
  const action = choice(input.action, "action", ["health", "batches", "outbox", "ack", "reply"]);
  const store = new Store();
  try {
    const result = store.atomic(true, () => {
      const task = boundTask(store, config);
      store.run("UPDATE bridge_sources SET body=NULL WHERE body IS NOT NULL AND received_at<=?", Date.now() - retention);
      if (action === "health") return { protocol: 1, bridge_id: config.bridge_id, task_id: task.id, database_id: config.database_id, generation: config.generation, platform_id: config.platform_id, bot_id: config.bot_id };
      if (action === "outbox") {
        const after = integer(input.after, "after", 0);
        const items = store.all("SELECT o.* FROM bridge_outbox o LEFT JOIN bridge_decisions d ON d.id=o.decision_id WHERE o.bridge_id=? AND o.generation=? AND o.acked=0 AND o.seq>? AND (o.kind='conclusion' OR (d.state='pending' AND d.expires_at>? AND d.contract_revision=?)) ORDER BY o.seq LIMIT 20", config.bridge_id, config.generation, after, Date.now(), task.current_revision);
        return { items };
      }
      const requestId = uuid(input.request_id, "request_id");
      const { config_digest: _credential, ...business } = input;
      const fingerprint = digest(canonical(business));
      const prior = store.one<{ fingerprint: string; result: string }>("SELECT fingerprint,result FROM bridge_requests WHERE bridge_id=? AND generation=? AND request_id=?", config.bridge_id, config.generation, requestId);
      if (prior) {
        requireValue(prior.fingerprint === fingerprint, "REQUEST_CONFLICT", "request_id 已用于不同内容");
        return JSON.parse(prior.result) as Record<string, unknown>;
      }
      let value: Record<string, unknown>;
      if (action === "batches") value = receiveBatch(store, task, config, object(input.payload, "payload"));
      else if (action === "reply") value = receiveDecision(store, task, config, object(input.payload, "payload"));
      else {
        const id = uuid(input.outbox_id, "outbox_id");
        requireValue(store.one("SELECT id FROM bridge_outbox WHERE id=? AND bridge_id=? AND generation=?", id, config.bridge_id, config.generation), "NOT_FOUND", "回传条目不存在");
        store.run("UPDATE bridge_outbox SET acked=1 WHERE id=?", id);
        value = { acked: id };
      }
      store.run("INSERT INTO bridge_requests VALUES(?,?,?,?,?)", config.bridge_id, config.generation, requestId, fingerprint, JSON.stringify(value));
      return value;
    });
    const warnings = action === "batches" || action === "reply" ? notifyCommitted(store.directory) : [];
    return { ok: true, ...result, ...(warnings.length ? { warnings } : {}) };
  } finally { store.close(); }
}

/** Pi 侧显式选择回传内容、建立/撤销题面或按需读取原文；沿用成员与请求去重。 */
export function localBridge(store: Store, task: Task, request: Request): Record<string, unknown> {
  const member = requireMember(store, task, request);
  const config = bridgeConfig();
  requireValue(config && config.task_id === task.id, "CONFIG", "此房间未配置桥接");
  boundTask(store, config);
  const input = object(request.bridge, "bridge");
  const action = choice(input.action, "bridge.action", ["inbox", "decision", "create-decision", "cancel-decision", "conclusion"]);
  if (action === "inbox") {
    requireValue(request.command === "read", "INPUT", "inbox 使用 read");
    const batch = uuid(input.batch_id, "batch_id");
    requireValue(store.one("SELECT id FROM bridge_batches WHERE id=? AND task_id=?", batch, task.id), "NOT_FOUND", "批次不存在");
    return { items: store.all("SELECT platform_id,group_id,message_id,sender_id,received_at,CASE WHEN received_at>? THEN body ELSE NULL END AS body FROM bridge_sources WHERE batch_id=? ORDER BY received_at,message_id", Date.now() - retention, batch) };
  }
  if (action === "decision") {
    requireValue(request.command === "read", "INPUT", "decision 使用 read");
    const decision = store.one<Decision>("SELECT * FROM bridge_decisions WHERE id=? AND task_id=?", uuid(input.decision_id, "decision_id"), task.id);
    requireValue(decision, "NOT_FOUND", "决定不存在");
    return { decision };
  }
  requireValue(request.command === "update", "INPUT", "桥接写入使用 update");
  if (action === "cancel-decision") {
    const id = uuid(input.decision_id, "decision_id");
    requireValue(store.one("SELECT id FROM bridge_decisions WHERE id=? AND task_id=? AND state='pending'", id, task.id), "NOT_FOUND", "待决项不存在");
    store.run("UPDATE bridge_decisions SET state='cancelled' WHERE id=?", id);
    return { cancelled: id };
  }
  const batch = store.one<{ id: string; group_id: string }>("SELECT id,group_id FROM bridge_batches WHERE id=? AND task_id=? AND bridge_id=? AND generation=?", uuid(input.batch_id, "batch_id"), task.id, config.bridge_id, config.generation);
  requireValue(batch, "NOT_FOUND", "当前世代批次不存在");
  let body: string, target: string, decisionId: string | null = null;
  if (action === "conclusion") {
    body = text(input.body, "body", 512);
    requireValue(!/[\r\n`]/.test(body), "INPUT", "只回传一句纯文本结论，不含代码块");
    target = batch.group_id;
  } else {
    requireValue(input.contract_revision === task.current_revision, "VERSION_CONFLICT", "题面必须引用当前合同");
    const question = text(input.question, "question", 4096);
    const options = object(input.options, "options");
    const entries = Object.entries(options);
    requireValue(entries.length >= 2 && entries.length <= 8 && entries.every(([id]) => /^[a-zA-Z0-9_-]{1,32}$/.test(id)), "INPUT", "options 需要2–8个简短选项ID");
    for (const [, label] of entries) text(label, "option label", 512);
    const expires = integer(input.expires_at, "expires_at", Date.now() + 86400_000);
    requireValue(expires > Date.now() && expires <= Date.now() + retention, "INPUT", "有效期必须在未来七天内");
    if (input.replaces !== undefined) {
      const old = uuid(input.replaces, "replaces");
      requireValue(store.one("SELECT id FROM bridge_decisions WHERE id=? AND task_id=? AND state='pending'", old, task.id), "NOT_FOUND", "被替换的待决项不存在");
      store.run("UPDATE bridge_decisions SET state='cancelled' WHERE id=?", old);
    }
    decisionId = newId();
    const hash = digest(canonical({ question, options, contract_revision: task.current_revision, batch_id: batch.id, expires_at: expires, member_id: member.id, generation: config.generation }));
    store.run("INSERT INTO bridge_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?)", decisionId, config.bridge_id, task.id, config.generation, task.current_revision, batch.id, member.id, question, JSON.stringify(options), hash, expires, new Date().toISOString());
    body = `${question}\n${entries.map(([id, label]) => `${id}: ${label}`).join("\n")}\n决定 ${decisionId}\n回复：确认 ${decisionId} <选项>\n有效期 ${new Date(expires).toISOString()}\n合同 ${task.current_revision}\n哈希 ${hash}`;
    target = config.owner_id;
  }
  const id = newId();
  store.run("INSERT INTO bridge_outbox(id,bridge_id,task_id,generation,kind,target,body,decision_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", id, config.bridge_id, task.id, config.generation, decisionId ? "decision" : "conclusion", target, body, decisionId, new Date().toISOString());
  return { outbox_id: id, decision_id: decisionId, author: authorFor(request, member) };
}
