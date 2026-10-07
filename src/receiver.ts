import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { canonical, excerpt, inboxText, newId } from "./protocol.ts";
import type { Cursor, InboxResult } from "./protocol.ts";
import { changeSignal, dataDirectory } from "./signals.ts";
import type { Membership, ModelIdentity } from "./members.ts";

/** 用户选择的任务，收到的协作内容不能改变这个选择。 */
export interface Selection { database_id: string; generation: string; task_id: string; title?: string }

/** 分支内的成员持有信息；恢复只能核对这个凭证，不能自动重新取得身份。 */
export interface MemberBinding extends Membership { model: ModelIdentity }

/** 自由查询确实返回过的消息，只用来抑制同一分支的重复投递。 */
export interface ViewedMessage { id: string; event_seq: number }

/** 工具结果与空闲批次共享一个持久化检查点，版本用于识别可恢复的记录。 */
export interface Details {
  collab_version: 2;
  session_id: string;
  selection?: Selection;
  clear_selection?: boolean;
  checkpoint?: Cursor;
  delivery_id?: string;
  delivery_basis?: string;
  task_id?: string;
  reset?: boolean;
  blocked?: boolean;
  request_id?: string;
  membership?: MemberBinding;
  joined?: boolean;
  lease?: string;
  superseded?: boolean;
  viewed?: ViewedMessage[];
  result?: Record<string, unknown>;
}

/** 一个任务只有一个收件位置；重置标识隔离先前排队的消息。 */
export interface BranchState {
  selected?: Selection;
  checkpoints: Map<string, Cursor>;
  resets: Map<string, string>;
  blocked: Set<string>;
  memberships: Map<string, MemberBinding>;
  superseded: Set<string>;
  viewed: Map<string, Map<string, number>>;
  deliveredBatches: Set<string>;
}

/** 工具结果钩子发生在持久化之前，只在该短窗口补入结果。 */
interface PendingTool { id: string; details: Details }

/** 模型工具与空闲接收共用有截止时间的异步 CLI。 */
export type Invoke = (command: string, input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal, timeout?: number) => Promise<Record<string, unknown>>;

/** 原生分支条目是交付证据；新进度不会被迟到的旧批次回退。 */
export function branchState(ctx: ExtensionContext, pending?: PendingTool): BranchState {
  const state: BranchState = { checkpoints: new Map(), resets: new Map(), blocked: new Set(), memberships: new Map(), superseded: new Set(), viewed: new Map(), deliveredBatches: new Set() };
  const apply = (details: Details | undefined, toolId?: string, automatic = false): void => {
    if (!details || details.collab_version !== 2 || details.session_id !== ctx.sessionManager.getSessionId()) return;
    const taskId = details.selection?.task_id ?? details.task_id;
    if (taskId) {
      const prior = state.memberships.get(taskId);
      if (!details.joined && details.lease !== undefined && details.lease !== prior?.lease) return;
      if (automatic && ((details.delivery_basis ?? "") !== (state.resets.get(taskId) ?? "") || details.lease !== prior?.lease || state.superseded.has(taskId))) return;
      if (automatic && details.delivery_id) state.deliveredBatches.add(details.delivery_id);
      if (details.joined && details.membership) {
        state.memberships.set(taskId, details.membership);
        if (prior?.lease !== details.membership.lease) {
          // 新 lease 隔离进度，但已交付讨论仍是本分支历史；只有世代变化重置上下文。
          const checkpoint = state.checkpoints.get(taskId);
          if (checkpoint && details.checkpoint?.generation !== checkpoint.generation) state.resets.set(taskId, details.membership.lease);
          state.checkpoints.delete(taskId); state.viewed.delete(taskId);
        }
        state.blocked.delete(taskId); state.superseded.delete(taskId);
      }
      if (details.superseded) state.superseded.add(taskId);
    }
    if (details.clear_selection) state.selected = undefined;
    if (details.selection) state.selected = details.selection;
    if (taskId && details.reset && toolId) {
      state.resets.set(taskId, toolId);
      state.checkpoints.delete(taskId);
      state.blocked.delete(taskId);
      state.viewed.delete(taskId);
    }
    if (taskId && details.blocked) state.blocked.add(taskId);
    if (details.checkpoint) {
      const next = details.checkpoint;
      const prior = state.checkpoints.get(next.task_id);
      if (!prior || prior.generation !== next.generation || next.after.seq >= prior.after.seq) state.checkpoints.set(next.task_id, next);
    }
    if (taskId && details.viewed && details.lease && !state.superseded.has(taskId) && details.lease === state.memberships.get(taskId)?.lease) {
      const viewed = state.viewed.get(taskId) ?? new Map<string, number>();
      for (const message of details.viewed) viewed.set(message.id, message.event_seq);
      state.viewed.set(taskId, viewed);
    }
  };
  let pendingStored = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "collab") {
      apply(entry.message.details as Details | undefined, entry.message.toolCallId);
      if (entry.message.toolCallId === pending?.id) pendingStored = true;
    } else if (entry.type === "custom_message" && ["collab.batch", "collab.error"].includes(entry.customType)) {
      apply(entry.details as Details | undefined, undefined, true);
    } else if (entry.type === "custom" && entry.customType === "collab.state") {
      apply(entry.data as Details | undefined, entry.id);
    } else if (entry.type === "custom" && entry.customType === "collab.cursor") {
      apply(entry.data as Details | undefined, undefined, true);
    }
  }
  if (pending && !pendingStored) apply(pending.details, pending.id);
  for (const [taskId, viewed] of state.viewed) {
    const after = state.checkpoints.get(taskId)?.after.seq ?? 0;
    for (const [id, sequence] of viewed) if (sequence <= after) viewed.delete(id);
  }
  return state;
}

/** 模型名来自 Pi 当前选中项，虚拟路由后的物理模型不改变成员身份。 */
export function piModel(ctx: ExtensionContext): ModelIdentity | undefined {
  return ctx.model?.name ? { name: ctx.model.name, provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

/** 底部以主题和模型为入口；稳定房间身份由菜单的复制加入指令提供。 */
export function roomStatus(ctx: ExtensionContext, selected: Selection, note: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("collab", `collab ${excerpt(selected.title ?? "房间", 18)} · ${excerpt(ctx.model?.name ?? "模型未就绪", 24)} · ${note}`);
}

/** 命令和模型选择在记录新绑定后刷新同一个收件器。 */
export interface ReceiverControl { refresh(ctx: ExtensionContext): Promise<void>; invalidate(): void }

/** 忙碌时只记录变化；空闲时合并未读内容并启动当前会话。 */
export function registerReceiver(pi: ExtensionAPI, invoke: Invoke): ReceiverControl {
  let context: ExtensionContext | undefined;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let pendingTool: PendingTool | undefined;
  let pendingMessage: string | undefined;
  let binding: string | undefined;
  let epoch = 0;
  let stopped = true;
  let dirty = false;
  let starting = false;
  let active = false;
  let prompts = 0;
  let failures = 0;
  let watchFailures = 0;
  let deliveryFailures = 0;
  let paused = false;
  let lastError: string | undefined;
  let deferred = 0;

  /** 原生空闲状态和生命周期标记共同排除启动、用户对话与待发送消息。 */
  const idle = (ctx: ExtensionContext): boolean => !stopped && !starting && !active && !prompts && !paused && ctx.isIdle() && !ctx.hasPendingMessages();
  const cancelRead = (): void => { epoch++; controller?.abort(); };
  const release = (): void => {
    cancelRead();
    watcher?.close(); watcher = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined; pendingMessage = undefined; binding = undefined;
  };
  const schedule = (delay = 40): void => {
    dirty = true;
    if (!context || !idle(context) || timer || running) return;
    timer = setTimeout(() => { timer = undefined; if (context) void synchronize(context); }, delay);
    timer.unref();
  };
  const report = (ctx: ExtensionContext, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) {
      ctx.ui.setStatus("collab", "collab 接收暂停");
      if (message !== lastError) ctx.ui.notify(`collab：${message}`, "warning");
    }
    lastError = message;
  };
  const recorded = (ctx: ExtensionContext, id: string): boolean => ctx.sessionManager.getBranch().some(entry =>
    entry.type === "custom_message" && entry.customType === "collab.batch" && (entry.details as Details | undefined)?.delivery_id === id,
  );

  /** 绑定监听不读取正文；实际查询前后都核对空闲状态，避免在等待 CLI 时侵入新回合。 */
  const receive = async (ctx: ExtensionContext): Promise<void> => {
    const state = branchState(ctx, pendingTool);
    const selected = state.selected;
    const member = selected ? state.memberships.get(selected.task_id) : undefined;
    const key = selected ? JSON.stringify([ctx.sessionManager.getSessionId(), selected.database_id, selected.task_id, member?.lease, ctx.model?.name]) : undefined;
    if (key !== binding) { release(); binding = key; }
    if (!selected) { if (ctx.hasUI) ctx.ui.setStatus("collab", undefined); return; }
    if (!member || state.superseded.has(selected.task_id) || ctx.model?.name !== member.model.name) {
      release();
      roomStatus(ctx, selected, state.superseded.has(selected.task_id) ? "已被接替 · 只读" : "待加入");
      return;
    }
    roomStatus(ctx, selected, "空闲接收");
    if (!watcher) {
      if (watchFailures >= 3) { report(ctx, "目录监听连续失败；使用 /collab info 或 reload 后重新绑定"); return; }
      if (!existsSync(dataDirectory())) throw new Error("任务数据库目录不存在，不能接收协作内容");
      const nextWatcher = watch(dataDirectory(), { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === changeSignal) {
          watchFailures = 0;
          failures = 0; deferred = 0; cancelRead();
          if (timer) { clearTimeout(timer); timer = undefined; }
          schedule();
        }
      });
      watcher = nextWatcher;
      nextWatcher.on("error", error => {
        if (watcher !== nextWatcher) return;
        nextWatcher.close(); watcher = undefined; report(ctx, error);
        if (++watchFailures < 3) schedule(watchFailures * 1000);
      });
    }
    if (!idle(ctx)) return;
    if (pendingMessage) {
      if (recorded(ctx, pendingMessage)) { pendingMessage = undefined; deliveryFailures = 0; }
      else return;
    }
    if (state.blocked.has(selected.task_id)) { roomStatus(ctx, selected, "需核对恢复状态"); return; }
    const scope = epoch;
    const checkpoint = state.checkpoints.get(selected.task_id);
    const sessionId = ctx.sessionManager.getSessionId();
    const basis = state.resets.get(selected.task_id) ?? "";
    const operation = new AbortController();
    controller = operation;
    let result: Record<string, unknown>;
    try {
      result = await invoke("read", { ...selected, ...checkpoint, view: "content", automatic: true, membership: member, model: piModel(ctx),
        delivered: [...state.viewed.get(selected.task_id)?.keys() ?? []], client: "pi", session_id: sessionId }, ctx, operation.signal, 10_000);
    } catch (error) {
      if (scope !== epoch || stopped || operation.signal.aborted) return;
      throw error;
    } finally { if (controller === operation) controller = undefined; }
    if (scope !== epoch || !idle(ctx)) return;
    if (result.ok === false) {
      const error = result.error as { code: string; message: string };
      if (["SUPERSEDED", "JOIN_REQUIRED", "MODEL_UNAVAILABLE"].includes(error.code)) {
        pi.appendEntry("collab.cursor", { collab_version: 2, session_id: sessionId, task_id: selected.task_id, lease: member.lease, delivery_basis: basis, superseded: true } satisfies Details);
        release(); roomStatus(ctx, selected, "已被接替 · 只读");
        return;
      }
      if (["GENERATION_CHANGED", "HISTORY_DIVERGED", "DATABASE_CHANGED"].includes(error.code)) {
        const details: Details = { collab_version: 2, session_id: sessionId, task_id: selected.task_id, delivery_basis: basis, lease: member.lease, blocked: true };
        pi.appendEntry("collab.cursor", details);
        pi.sendMessage({ customType: "collab.error", content: `协作接续已暂停：${JSON.stringify(error)}。核对当前合同后重同步；恢复导致成员凭证失效时需 open rejoin:true 明确重新加入。`, display: true, details }, { triggerTurn: true });
      }
      throw new Error(`${error.code}: ${error.message}`);
    }
    failures = 0; lastError = undefined;
    roomStatus(ctx, selected, "空闲接收");
    const batch = result as unknown as InboxResult;
    if (batch.wait_ms) { deferred = batch.wait_ms; dirty = true; return; }
    deferred = 0;
    const details: Details = { collab_version: 2, session_id: sessionId, task_id: selected.task_id, delivery_basis: basis, lease: member.lease, checkpoint: batch.next };
    if (!batch.total_events) {
      if (canonical(checkpoint) !== canonical(batch.next)) pi.appendEntry("collab.cursor", details);
      return;
    }
    details.delivery_id = newId();
    pendingMessage = details.delivery_id;
    pi.sendMessage({ customType: "collab.batch", content: inboxText(batch), display: true, details }, { triggerTurn: true });
  };

  /** 文件变化合并为一次空闲查询；正常空结果不安排定时轮询。 */
  const synchronize = async (ctx: ExtensionContext): Promise<void> => {
    context = ctx;
    if (stopped) return;
    if (running) { dirty = true; return; }
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (idle(ctx)) dirty = false;
    running = (async () => {
      try { await receive(ctx); }
      catch (error) { report(ctx, error); if (++failures <= 3) dirty = true; }
    })();
    await running; running = undefined;
    if (dirty && !pendingMessage) schedule(failures ? failures * 1000 : deferred || 40);
  };
  const reset = (_event: unknown, ctx: ExtensionContext): void => {
    release(); stopped = false; context = ctx; pendingTool = undefined;
    starting = false; active = !ctx.isIdle(); prompts = 0; failures = 0; watchFailures = 0; deliveryFailures = 0; paused = false; lastError = undefined;
    void synchronize(ctx);
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("tool_result", async (event, ctx) => {
    context = ctx; paused = false;
    if (event.toolName === "collab") {
      watchFailures = 0;
      const details = event.details as Details | undefined;
      if (details?.collab_version === 2) {
        const previous = branchState(ctx, pendingTool).selected;
        pendingTool = { id: event.toolCallId, details };
        if (details.joined || details.superseded || details.reset || details.clear_selection || (details.selection && (details.selection.task_id !== previous?.task_id || details.selection.database_id !== previous?.database_id))) release();
        else if (details.checkpoint || details.viewed) cancelRead();
      }
    }
    // 仅 collab 结果可能改变绑定；其他工具不启动数据库读取。
    if (event.toolName === "collab") await synchronize(ctx);
  });
  /** 整个工具批次结束才接收紧急正文；返回的条目由 Pi 原子写入当前分支。 */
  pi.on("turn_end", async (event, ctx) => {
    if (event.outcome === "aborted") { paused = true; cancelRead(); return; }
    if (ctx.hasPendingMessages()) return;
    if (!dirty || stopped || paused || prompts || event.outcome !== "completed" || !event.context.canContinue || ctx.signal?.aborted) return;
    cancelRead();
    const scope = epoch;
    if (running) await running;
    if (scope !== epoch || stopped || paused || prompts || ctx.signal?.aborted) return;
    const state = branchState(ctx);
    const selected = state.selected;
    const member = selected && state.memberships.get(selected.task_id);
    if (!selected || !member || state.blocked.has(selected.task_id) || state.superseded.has(selected.task_id) || member.model.name !== ctx.model?.name) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const basis = state.resets.get(selected.task_id) ?? "";
    const operation = new AbortController();
    controller = operation;
    const abort = (): void => operation.abort();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      dirty = false;
      const result = await invoke("read", { ...selected, ...state.checkpoints.get(selected.task_id), view: "content", automatic: true, urgent_only: true,
        membership: member, model: piModel(ctx), delivered: [...state.viewed.get(selected.task_id)?.keys() ?? []], client: "pi", session_id: sessionId }, ctx, operation.signal, 10_000);
      if (scope !== epoch || stopped || prompts || operation.signal.aborted || ctx.signal?.aborted) return;
      if (!result.ok) {
        const error = result.error as { code: string; message: string };
        if (["SUPERSEDED", "JOIN_REQUIRED", "MODEL_UNAVAILABLE"].includes(error.code)) {
          pi.appendEntry("collab.cursor", { collab_version: 2, session_id: sessionId, task_id: selected.task_id, lease: member.lease, delivery_basis: basis, superseded: true } satisfies Details);
          release(); roomStatus(ctx, selected, "已被接替 · 只读");
        } else {
          if (["GENERATION_CHANGED", "HISTORY_DIVERGED", "DATABASE_CHANGED"].includes(error.code)) {
            pi.appendEntry("collab.cursor", { collab_version: 2, session_id: sessionId, task_id: selected.task_id, lease: member.lease, delivery_basis: basis, blocked: true } satisfies Details);
          } else if (++failures <= 3) dirty = true;
          report(ctx, `${error.code}: ${error.message}`);
        }
        return;
      }
      failures = 0; lastError = undefined;
      const batch = result as unknown as InboxResult;
      if (!batch.total_events) return;
      dirty ||= batch.omitted_events > 0;
      const details: Details = { collab_version: 2, session_id: sessionId, task_id: selected.task_id, lease: member.lease, delivery_basis: basis,
        delivery_id: newId(), viewed: batch.messages.filter(item => item.kind === "posted").map(item => ({ id: item.object_id, event_seq: item.seq })) };
      const entry: CustomMessageEntryDraft = { type: "custom_message", customType: "collab.batch", content: inboxText(batch), details, display: true };
      return { entries: [...event.entries, entry], continue: true };
    } catch (error) {
      if (!operation.signal.aborted && scope === epoch) { if (++failures <= 3) dirty = true; report(ctx, error); }
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      if (controller === operation) controller = undefined;
    }
  });
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; starting = true; paused = false; cancelRead(); });
  pi.on("agent_start", (_event, ctx) => { context = ctx; starting = false; active = true; });
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx; active = false; starting = false;
    if (pendingMessage && !recorded(ctx, pendingMessage) && !ctx.hasPendingMessages()) {
      pendingMessage = undefined;
      if (++deliveryFailures >= 2) { paused = true; report(ctx, "批次尚未进入会话记录，已暂停自动激活；后续工具操作或重载后重试"); return; }
    }
    schedule(deliveryFailures ? 1000 : 40);
  });
  pi.on("ui_prompt_start", () => { prompts++; cancelRead(); });
  pi.on("ui_prompt_end", (_event, ctx) => { prompts = Math.max(0, prompts - 1); context = ctx; schedule(); });
  pi.on("context", (event, ctx) => {
    const state = branchState(ctx);
    return { messages: event.messages.filter(message => {
      if (message.role !== "custom") return true;
      // 退役的提醒和逐段消息保留在历史记录中，不再进入当前协作上下文。
      if (["collab.reminder", "collab.delivery"].includes(message.customType)) return false;
      if (!["collab.batch", "collab.error"].includes(message.customType)) return true;
      const details = message.details as Details | undefined;
      if (details?.collab_version !== 2) return false;
      const taskId = details.task_id;
      return taskId === state.selected?.task_id &&
        (message.customType !== "collab.batch" || !!details.delivery_id && state.deliveredBatches.has(details.delivery_id)) &&
        (details.delivery_basis ?? "") === (state.resets.get(taskId ?? "") ?? "");
    }) };
  });
  pi.on("session_shutdown", () => { stopped = true; release(); context = undefined; pendingTool = undefined; dirty = false; });
  return {
    invalidate: cancelRead,
    refresh: async ctx => { paused = false; watchFailures = 0; cancelRead(); await synchronize(ctx); },
  };
}
