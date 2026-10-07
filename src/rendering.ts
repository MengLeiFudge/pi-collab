import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Details } from "./receiver.ts";
import type { InboxResult } from "./protocol.ts";
import { excerpt } from "./protocol.ts";

/** 摘要压成一行；完整正文仅由展开态显示，不改模型输入。 */
function brief(value: string): string {
  return excerpt(value.replace(/\s+/g, " ").trim(), 100);
}

/** 系统事件与发帖分别计数，避免把范围登记称为聊天消息。 */
export function receivedSummary(batch: InboxResult, actor: string): string {
  const messages = batch.messages.filter(item => item.kind === "posted").length;
  const updates = batch.messages.length - messages;
  return `${actor} 收到了 ${messages} 条消息${updates ? `、${updates} 条协作更新` : ""}${batch.omitted_events ? `（另有 ${batch.omitted_events} 项可查）` : ""}`;
}

/** 从结构化结果生成动作摘要；旧会话或错误结果可退回正文首行。 */
function resultSummary(details: Details | undefined, body: string, input?: Record<string, unknown>): string {
  if (details?.display_summary) return details.display_summary;
  const result = details?.result;
  const actor = details?.model_name ?? details?.membership?.model.name ?? "当前会话";
  if (result?.ok === false) return `${actor} 协作操作失败：${brief(String((result.error as { message?: string })?.message ?? body))}`;
  if (result?.view === "content" && Array.isArray(result.messages)) return receivedSummary(result as unknown as InboxResult, actor);
  if (details?.command === "post") return `${actor} 发送了一条消息：${brief(String(input?.summary ?? input?.body ?? ""))}`;
  if (details?.command === "open" && details.selection) return `${actor} ${details.joined ? "加入" : "查看"}了房间：${details.selection.title ?? "协作房间"}`;
  const actions: Record<string, string> = { update: "更新了协作记录", resolve: "处理了一条意见", snapshot: "保存了快照", export: "导出了协作记录", show: "查看了协作内容", read: "读取了协作内容" };
  if (details?.command && actions[details.command]) return `${actor} ${actions[details.command]}`;
  return brief(body.split("\n", 1)[0] || "协作消息");
}

/** 折叠态只显示摘要与真实渲染行数；Text 负责宽字符、换行和宽度缓存。 */
class FoldedText implements Component {
  private readonly text: Text;

  constructor(private readonly summary: string, body: string, private readonly expanded: () => boolean, private readonly theme: Theme) {
    this.text = new Text(body, 0, 0);
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    if (this.expanded()) return lines;
    return [
      truncateToWidth(this.theme.fg("accent", this.summary), width),
      truncateToWidth(this.theme.fg("muted", `还有 ${lines.length} 行，`) + keyHint("app.tools.expand", "展开"), width),
    ];
  }

  invalidate(): void { this.text.invalidate(); }
}

/** 工具行的键盘与鼠标展开由 Pi 自带容器维护；不另设快捷键。 */
export const toolRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const command = (args as { command?: string } | undefined)?.command;
    const title = `Collab · ${typeof command === "string" ? command : "操作"}`;
    if (context.expanded) return new Text(`${title}\n${JSON.stringify(args, null, 2)}`, 0, 0);
    return { render: width => [truncateToWidth(theme.fg("toolTitle", title), width)], invalidate() {} };
  },
  renderResult(result, options, theme, context) {
    const body = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    const summary = options.isPartial ? "协作操作进行中" : resultSummary(result.details as Details | undefined, body, (context.args as { input?: Record<string, unknown> } | undefined)?.input);
    return new FoldedText(summary, body, () => options.expanded, theme);
  },
};

/** 自定义消息没有工具容器，鼠标状态由消息对象持有，原生展开状态变化时同步。 */
export function registerRendering(pi: ExtensionAPI): void {
  const states = new WeakMap<object, { native: boolean; expanded: boolean }>();
  for (const type of ["collab.batch", "collab.room", "collab.error"]) {
    pi.registerMessageRenderer<Details>(type, (message, options, theme) => {
      let state = states.get(message);
      if (!state || state.native !== options.expanded) {
        state = { native: options.expanded, expanded: options.expanded };
        states.set(message, state);
      }
      const body = typeof message.content === "string" ? message.content : message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      const text = new FoldedText(resultSummary(message.details, body), body, () => state.expanded, theme);
      return new MouseRegion(text, event => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        state.expanded = !state.expanded;
        text.invalidate();
        return { handled: true, render: true };
      });
    });
  }
}
