import { createHash } from "node:crypto";
import { hasQuery } from "./chat.js";
import { branchState, piModel } from "./receiver.js";
import { failure, requireValue } from "./protocol.js";
import { resultText } from "./presentation.js";
/** 同一次调用导出稳定请求 UUID；超时后必须显式沿用，不能以新调用号重发。 */
function requestId(session, call) {
    const bytes = createHash("sha256").update(`${session}\0${call}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** 从服务返回的身份构建分支选择；模型提供的参数不能伪造身份。 */
function selection(result) {
    if (typeof result.task_id !== "string" || typeof result.database_id !== "string" || typeof result.generation !== "string")
        return undefined;
    return { database_id: result.database_id, generation: result.generation, task_id: result.task_id,
        title: result.task?.title };
}
/** 统一注入模型与凭证；世代校验、只读查阅和实际交付记录分别保留各自语义。 */
export function createAdapter(invoke, epoch) {
    return async (callId, params, ctx, signal) => {
        const scope = epoch();
        const state = branchState(ctx);
        const sessionId = ctx.sessionManager.getSessionId();
        const model = piModel(ctx);
        const input = { ...params.input, client: "pi", session_id: sessionId, model };
        for (const field of ["membership", "join", "automatic", "delivered", "urgent_only", "user_action", "prepare_creation"])
            delete input[field];
        if (!params.userAction && ["leave", "preferences", "release-scopes"].includes(String(input.action)))
            return { content: [{ type: "text", text: "成员设置和离开由用户通过 /collab 菜单控制。" }], details: { collab_version: 2, session_id: sessionId }, isError: true };
        const discovery = params.command === "open" && input.action === "rooms";
        const invite = params.command === "open" && input.action === "invite";
        const details = { collab_version: 2, session_id: sessionId, model_name: model?.name, command: params.command };
        const userRelease = params.command === "open" && input.action === "release-scopes" && params.userAction === true;
        if (userRelease)
            input.user_action = true;
        const writing = userRelease || ["post", "update", "resolve", "snapshot"].includes(params.command);
        const freeQuery = params.command === "read" && hasQuery(input);
        let joining = false;
        let claim;
        let selected;
        const fixRequest = () => {
            input.request_id ??= requestId(sessionId, callId);
            if (typeof input.request_id === "string")
                details.request_id = input.request_id;
        };
        if (writing || params.command === "open" && !params.inspect)
            fixRequest();
        try {
            requireValue(!params.reset || params.command === "read" && !freeQuery && !input.counts_only && (input.view === undefined || input.view === "content"), "INPUT", "reset 仅用于未读正文，不能重置自由查询或事件索引");
            requireValue(input.rejoin === undefined || typeof input.rejoin === "boolean", "INPUT", "rejoin 必须为布尔值");
            if (params.command === "snapshot")
                input.worktree ??= ctx.cwd;
            if (params.command === "update" && input.assignment && typeof input.assignment === "object" && !Array.isArray(input.assignment)) {
                const assignment = input.assignment;
                if (assignment.action === "register")
                    input.assignment = { workspace: ctx.cwd, ...assignment };
            }
            if (discovery)
                input.project_root ??= ctx.cwd;
            if (params.command === "open" && input.create === true)
                input.project_root ??= ctx.cwd;
            if (input.task_id === undefined && input.create !== true && !discovery && state.selected)
                input.task_id = state.selected.task_id;
            const taskId = typeof input.task_id === "string" ? input.task_id : "";
            const checkpoint = state.checkpoints.get(taskId);
            selected ??= state.selected?.task_id === taskId ? state.selected : checkpoint;
            claim = state.memberships.get(taskId);
            input.membership = claim;
            details.task_id = taskId || undefined;
            details.lease = claim?.lease;
            if (selected)
                details.selection = selected;
            joining = params.command === "open" && !params.inspect && !invite && !discovery && !userRelease && !!(taskId || input.create === true) &&
                (!claim || input.rejoin === true || claim.model.name !== model?.name || params.input?.request_id !== undefined);
            delete input.rejoin;
            if (joining) {
                requireValue(model, "MODEL_UNAVAILABLE", "Pi 尚未提供选中模型，不能加入房间");
                input.join = true;
                // 明确的新加入可以接续恢复后的库；重试则保留原世代，不能把旧请求重新提交。
                input.database_id ??= selected?.database_id;
                if (params.input?.request_id !== undefined)
                    input.generation ??= selected?.generation;
            }
            if (writing) {
                requireValue(!state.blocked.has(taskId), "HISTORY_DIVERGED", "需先核对合同，再 read reset:true 或明确重新加入");
                requireValue(!checkpoint || input.generation === undefined || input.generation === checkpoint.generation, "GENERATION_CHANGED", "不能绕过旧检查点改绑写请求");
            }
            if (!params.reset && !joining && selected) {
                input.database_id ??= selected.database_id;
                input.generation ??= selected.generation;
                if (writing || params.command === "open" || params.command === "read" && !freeQuery && input.view !== "index")
                    input.after ??= checkpoint?.after;
            }
            if (params.command === "read") {
                input.view ??= freeQuery ? "messages" : "content";
                if (!freeQuery && input.view === "content")
                    input.delivered = [...state.viewed.get(taskId)?.keys() ?? []];
            }
            if (params.reset) {
                delete input.after;
                delete input.window;
                delete input.issues_after;
                delete input.generation;
            }
            if (params.command === "open" && input.create === true && input.task_id === undefined) {
                if (params.input?.request_id !== undefined) {
                    requireValue(typeof input.database_id === "string" && typeof input.generation === "string", "INPUT", "重试建房须同时传回原 request_id、database_id 和 generation；先核对原结果，不能重新选择世代");
                }
                else if (input.database_id === undefined || input.generation === undefined) {
                    const prepared = await invoke("open", { ...input, prepare_creation: true }, ctx, signal);
                    requireValue(prepared.ok, "CREATE", "建房准备失败", { result: prepared });
                    input.database_id = prepared.database_id;
                    input.generation = prepared.generation;
                }
            }
            const result = await invoke(params.command, input, ctx, signal);
            requireValue(scope === epoch() && sessionId === ctx.sessionManager.getSessionId() && model?.name === piModel(ctx)?.name, "CONTEXT_CHANGED", "调用期间会话、分支或选中模型已变化；写入可能已经完成，请用原 request_id 核对");
            const nextSelection = selection(result);
            details.stats = result.display_stats;
            delete result.display_stats;
            details.result = result;
            if (result.left === true) {
                details.clear_selection = true;
                details.superseded = true;
            }
            if (nextSelection && result.left !== true)
                details.selection = { ...nextSelection, title: nextSelection.title ?? selected?.title };
            const room = result.room;
            const status = result.membership_status ?? room?.membership_status;
            if (result.ok === false) {
                const code = result.error.code;
                details.blocked = ["HISTORY_DIVERGED", "GENERATION_CHANGED", "DATABASE_CHANGED"].includes(code);
                details.superseded = code === "SUPERSEDED";
            }
            else if (joining && result.membership) {
                details.membership = { ...result.membership, model: model };
                details.joined = true;
                details.lease = details.membership.lease;
                details.checkpoint = result.cursor;
            }
            else if (status === "superseded")
                details.superseded = true;
            else if (status === "active" && params.command === "read") {
                if (result.view === "content" && result.next) {
                    details.checkpoint = result.next;
                    details.reset = params.reset === true;
                }
                else if (result.view === "messages") {
                    details.viewed = result.messages.map(message => ({ id: message.id, event_seq: message.event_seq }));
                }
            }
            if (writing || joining)
                result.request_id = input.request_id;
            if (input.create === true && result.ok === false) {
                result.database_id ??= input.database_id;
                result.generation ??= input.generation;
            }
            if (details.clear_selection)
                delete details.selection;
            const output = resultText(result);
            return { content: [{ type: "text", text: output }], details, isError: result.ok === false };
        }
        catch (error) {
            const result = { ...failure(error), ...(details.request_id ? { request_id: details.request_id } : {}),
                ...(input.create === true ? { database_id: input.database_id, generation: input.generation } : {}) };
            const code = result.error.code;
            if (code === "CONTEXT_CHANGED") {
                // 失败结果仍交付请求号，但不把旧上下文的选择或凭证带进当前分支。
                return { content: [{ type: "text", text: JSON.stringify(result) }], details: { collab_version: 2, session_id: sessionId, request_id: details.request_id }, isError: true };
            }
            details.blocked = ["HISTORY_DIVERGED", "GENERATION_CHANGED", "DATABASE_CHANGED"].includes(code);
            details.superseded = code === "SUPERSEDED";
            return { content: [{ type: "text", text: JSON.stringify(result) }], details, isError: true };
        }
    };
}
