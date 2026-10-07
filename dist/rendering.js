import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { excerpt } from "./protocol.js";
/** 摘要压成一行；完整正文仅由展开态显示，不改模型输入。 */
function brief(value) {
    return excerpt(value.replace(/\s+/g, " ").trim(), 100);
}
/** 消息、系统更新与省略项分别显示，供实时批次和已保存摘要共用。 */
function receivedCounts(actor, messages, updates, omitted) {
    return `${actor} received ${messages} message${messages === 1 ? "" : "s"}${updates ? ` and ${updates} collaboration update${updates === 1 ? "" : "s"}` : ""}${omitted ? ` (${omitted} more available)` : ""}`;
}
/** 系统事件与发帖分别计数，避免把范围登记称为聊天消息。 */
export function receivedSummary(batch, actor) {
    const messages = batch.messages.filter(item => item.kind === "posted").length;
    return receivedCounts(actor, messages, batch.messages.length - messages, batch.omitted_events ?? 0);
}
/** 从结构化结果生成动作摘要；旧会话或错误结果可退回正文首行。 */
function resultSummary(details, body, input) {
    if (details?.display_summary) {
        // 已保存批次只有生成后的摘要；仅识别插件的固定格式，不翻译用户正文或改写历史。
        const saved = /^(.*) 收到了 (\d+) 条消息(?:、(\d+) 条协作更新)?(?:（另有 (\d+) 项可查）)?$/u.exec(details.display_summary);
        return saved ? receivedCounts(saved[1], Number(saved[2]), Number(saved[3] ?? 0), Number(saved[4] ?? 0)) : details.display_summary;
    }
    const result = details?.result;
    const actor = details?.model_name ?? details?.membership?.model.name ?? "Current session";
    if (result?.ok === false)
        return `${actor} collaboration failed: ${brief(String(result.error?.message ?? body))}`;
    if (result?.view === "content" && Array.isArray(result.messages))
        return receivedSummary(result, actor);
    if (details?.command === "post")
        return `${actor} sent a message: ${brief(String(input?.summary ?? input?.body ?? ""))}`;
    if (details?.command === "open" && details.selection)
        return `${actor} ${details.joined ? "joined" : "viewed"} room: ${details.selection.title ?? "Collaboration room"}`;
    const actions = { update: "updated collaboration records", resolve: "resolved an issue", snapshot: "saved a snapshot", export: "exported collaboration records", show: "viewed collaboration content", read: "read collaboration content" };
    if (details?.command && actions[details.command])
        return `${actor} ${actions[details.command]}`;
    return brief(body.split("\n", 1)[0] || "Collaboration message");
}
/** 折叠态只显示摘要与真实渲染行数；Text 负责宽字符、换行和宽度缓存。 */
class FoldedText {
    summary;
    expanded;
    theme;
    text;
    constructor(summary, body, expanded, theme) {
        this.summary = summary;
        this.expanded = expanded;
        this.theme = theme;
        this.text = new Text(body, 0, 0);
    }
    render(width) {
        const lines = this.text.render(width);
        if (this.expanded())
            return lines;
        return [
            truncateToWidth(this.theme.fg("accent", this.summary), width),
            truncateToWidth(this.theme.fg("muted", `${lines.length} more line${lines.length === 1 ? "" : "s"}, `) + keyHint("app.tools.expand", "expand"), width),
        ];
    }
    invalidate() { this.text.invalidate(); }
}
/** 工具行的键盘与鼠标展开由 Pi 自带容器维护；不另设快捷键。 */
export const toolRenderers = {
    renderCall(args, theme, context) {
        const command = args?.command;
        const title = `Collab · ${typeof command === "string" ? command : "operation"}`;
        if (context.expanded)
            return new Text(`${title}\n${JSON.stringify(args, null, 2)}`, 0, 0);
        return { render: width => [truncateToWidth(theme.fg("toolTitle", title), width)], invalidate() { } };
    },
    renderResult(result, options, theme, context) {
        const body = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        const summary = options.isPartial ? "Collaboration in progress" : resultSummary(result.details, body, context.args?.input);
        return new FoldedText(summary, body, () => options.expanded, theme);
    },
};
/** 自定义消息没有工具容器，鼠标状态由消息对象持有，原生展开状态变化时同步。 */
export function registerRendering(pi) {
    const states = new WeakMap();
    for (const type of ["collab.batch", "collab.room", "collab.error"]) {
        pi.registerMessageRenderer(type, (message, options, theme) => {
            let state = states.get(message);
            if (!state || state.native !== options.expanded) {
                state = { native: options.expanded, expanded: options.expanded };
                states.set(message, state);
            }
            const body = typeof message.content === "string" ? message.content : message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
            const summary = type === "collab.error" ? "Collab delivery paused" : resultSummary(message.details, body);
            const text = new FoldedText(summary, body, () => state.expanded, theme);
            // 自定义消息绕过 Pi 默认容器，需要自行提供背景与内边距；工具结果仍由宿主包裹。
            const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
            box.addChild(text);
            return new MouseRegion(box, event => {
                if (event.type !== "click" || event.button !== "left")
                    return undefined;
                state.expanded = !state.expanded;
                box.invalidate();
                return { handled: true, render: true };
            });
        });
    }
}
