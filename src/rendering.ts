import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Details } from "./receiver.ts";
import type { InboxResult } from "./protocol.ts";
import { excerpt } from "./protocol.ts";
import { sessionName } from "./identity.ts";

/** 摘要压成一行；完整正文仅由展开态显示，不改模型输入。 */
function brief(value: string): string {
  return excerpt(value.replace(/\s+/g, " ").trim(), 100);
}

/** 消息、系统更新与省略项分别显示，供实时批次和已保存摘要共用。 */
function receivedCounts(actor: string, messages: number, updates: number, omitted: number): string {
  return `${actor} received ${messages} message${messages === 1 ? "" : "s"}${updates ? ` and ${updates} collaboration update${updates === 1 ? "" : "s"}` : ""}${omitted ? ` (${omitted} more available)` : ""}`;
}

/** 系统事件与发帖分别计数，避免把范围登记称为聊天消息。 */
export function receivedSummary(batch: InboxResult, actor: string): string {
  const messages = batch.messages.filter(item => item.kind === "posted").length;
  return receivedCounts(actor, messages, batch.messages.length - messages, batch.omitted_events ?? 0);
}

/** 从结构化结果生成动作摘要；旧会话或错误结果可退回正文首行。 */
function resultSummary(details: Details | undefined, body: string, input?: Record<string, unknown>): string {
  if (details?.display_summary) {
    // 已保存批次只有生成后的摘要；仅识别插件的固定格式，不翻译用户正文或改写历史。
    const saved = /^(.*) 收到了 (\d+) 条消息(?:、(\d+) 条协作更新)?(?:（另有 (\d+) 项可查）)?$/u.exec(details.display_summary);
    return saved ? receivedCounts(saved[1], Number(saved[2]), Number(saved[3] ?? 0), Number(saved[4] ?? 0)) : details.display_summary;
  }
  const result = details?.result;
  const actor = details?.member_name ?? (details ? sessionName(details.model_name ?? details.membership?.model.name ?? "Current session",
    details.membership?.short_id ?? details.session_id.slice(0, 8)) : "Current session");
  if (result?.ok === false) return `${actor} collaboration failed: ${brief(String((result.error as { message?: string })?.message ?? body))}`;
  if (result?.view === "content" && Array.isArray(result.messages)) return receivedSummary(result as unknown as InboxResult, actor);
  if (details?.command === "post") return `${actor} sent a message: ${brief(String(input?.summary ?? input?.body ?? ""))}`;
  if (details?.command === "open" && details.selection) return `${actor} ${details.joined ? "joined" : "viewed"} room: ${details.selection.title ?? "Collaboration room"}`;
  const actions: Record<string, string> = { update: "updated collaboration records", resolve: "resolved an issue", snapshot: "saved a snapshot", export: "exported collaboration records", show: "viewed collaboration content", read: "read collaboration content" };
  if (details?.command && actions[details.command]) return `${actor} ${actions[details.command]}`;
  return brief(body.split("\n", 1)[0] || "Collaboration message");
}

/** 宿主注入的键位文本，Pi 1.5 起由渲染选项提供；仓库编译基线 1.0.4 的类型里还没有。 */
type HintSource = { keyText?: (keybinding: "app.tools.expand") => string };

/**
 * 折叠提示的键位文本只能问宿主：扩展自己 import 的 keyText/keyHint 看到的是另一份
 * 从未初始化的键位表，渲染出来是空字符串（Pi 发布的是 bundle，与扩展加载的包不是一个实例）。
 */
function expandHint(hints: HintSource, theme: Theme): string {
  const key = hints.keyText?.("app.tools.expand") ?? "";
  if (!key) return theme.fg("muted", "expand (no shortcut bound)");
  // 键名用强调色：默认的 dim 在深色消息底色上看不见。
  return `${theme.fg("accent", key)} ${theme.fg("muted", "to expand")}`;
}

/** 折叠态只显示摘要与真实渲染行数；Text 负责宽字符、换行和宽度缓存。 */
class FoldedText implements Component {
  private readonly text: Text;

  constructor(
    private readonly summary: string,
    body: string,
    private readonly expanded: () => boolean,
    private readonly theme: Theme,
    private readonly hints: HintSource,
  ) {
    this.text = new Text(body, 0, 0);
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    if (this.expanded()) return lines;
    return [
      truncateToWidth(this.theme.fg("accent", this.summary), width),
      truncateToWidth(
        this.theme.fg("muted", `${lines.length} more line${lines.length === 1 ? "" : "s"}, `) + expandHint(this.hints, this.theme),
        width,
      ),
    ];
  }

  invalidate(): void { this.text.invalidate(); }
}

/** 工具行的键盘与鼠标展开由 Pi 自带容器维护；不另设快捷键。 */
export const toolRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const command = (args as { command?: string } | undefined)?.command;
    const title = `Collab · ${typeof command === "string" ? command : "operation"}`;
    if (context.expanded) return new Text(`${title}\n${JSON.stringify(args, null, 2)}`, 0, 0);
    return { render: width => [truncateToWidth(theme.fg("toolTitle", title), width)], invalidate() {} };
  },
  renderResult(result, options, theme, context) {
    const body = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    const summary = options.isPartial ? "Collaboration in progress" : resultSummary(result.details as Details | undefined, body, (context.args as { input?: Record<string, unknown> } | undefined)?.input);
    return new FoldedText(summary, body, () => options.expanded, theme, context as HintSource);
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
      const summary = type === "collab.error" ? "Collab delivery paused" : resultSummary(message.details, body);
      const text = new FoldedText(summary, body, () => state.expanded, theme, options as HintSource);
      // 自定义消息绕过 Pi 默认容器，需要自行提供背景与内边距；工具结果仍由宿主包裹。
      const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
      box.addChild(text);
      return new MouseRegion(box, event => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        state.expanded = !state.expanded;
        box.invalidate();
        return { handled: true, render: true };
      });
    });
  }
}
