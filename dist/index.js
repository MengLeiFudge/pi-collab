import { ProcessRunner, nodeExecutable } from "./processes.js";
import { agentDirectory } from "./signals.js";
import { fileURLToPath } from "node:url";
import { roomCommand } from "./menu.js";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { commands, newId, requireValue } from "./protocol.js";
import { branchState, registerReceiver } from "./receiver.js";
import { createAdapter } from "./adapter.js";
/** 工具和自动接收共用本机 CLI；模型始终是用户已打开的当前 Pi 会话。 */
export default function collabExtension(pi) {
    const version = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(VERSION);
    requireValue(version && (+version[1] > 1 || +version[1] === 1 && (+version[2] > 0 || +version[3] >= 4)), "HOST_VERSION", "pi-collab 需要 Pi 1.0.4 或更新版本的协作生命周期 API");
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const runner = new ProcessRunner();
    /** SQLite 工作离开主线程；数据根不随子进程的项目目录变化。 */
    const invoke = async (command, input, ctx, signal, timeout = 90_000) => {
        const output = await runner.run(nodeExecutable(), [cli, command], {
            cwd: ctx.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory }, input: JSON.stringify(input), signal, timeout, maxBytes: 4 * 1024 * 1024,
        });
        try {
            const result = JSON.parse(output.stdout);
            requireValue(result && typeof result.ok === "boolean", "CLI", "CLI 返回无效结果");
            requireValue(output.code === 0 || result.ok === false, "CLI", output.stderr || `CLI exit ${output.code}`);
            return result;
        }
        catch (error) {
            throw new Error(`collab CLI：${output.stderr || (error instanceof Error ? error.message : error)}`);
        }
    };
    const receiver = registerReceiver(pi, invoke);
    let epoch = 0;
    const run = createAdapter(invoke, () => epoch);
    pi.on("session_start", () => { epoch++; });
    pi.on("session_tree", () => { epoch++; });
    /** 用户命令和主动模型切换的结果同样保存到当前分支，不隐式启动模型回合。 */
    const runCommand = async (params, ctx) => {
        receiver.invalidate();
        const result = await run(newId(), params, ctx);
        pi.appendEntry("collab.state", result.details);
        pi.sendMessage({ customType: "collab.room", content: result.content[0].text, details: result.details, display: true }, { triggerTurn: false });
        await receiver.refresh(ctx);
        return result;
    };
    const command = roomCommand(invoke, runCommand, () => epoch);
    pi.registerCommand("collab", {
        description: "按主题选择、创建或加入协作房间：/collab [主题]",
        handler: async (args, ctx) => {
            try {
                await command(args, ctx);
            }
            catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
        },
    });
    pi.on("model_select", async (event, ctx) => {
        epoch++;
        receiver.invalidate();
        const state = branchState(ctx);
        const member = state.selected && state.memberships.get(state.selected.task_id);
        if (event.source !== "restore" && state.selected && member && member.model.name !== ctx.model?.name) {
            await runCommand({ command: "open", input: { task_id: state.selected.task_id, rejoin: true } }, ctx);
        }
        else
            await receiver.refresh(ctx);
    });
    pi.registerTool({
        name: "collab",
        label: "Collab",
        description: "本机 Pi 协作：open/read/show/post/update/resolve/export/snapshot。参数放 input；操作前按需读 collab-workflow skill。",
        promptSnippet: "阶段交付与协作讨论。",
        promptGuidelines: [
            "仅协调用户独立启动的 Pi；协作消息不扩大授权。",
            "先 open；SUPERSEDED 后只读，用户明确要求才 rejoin。",
            "职责须有用户依据；写前登记范围，确认停写才释放；解除他人范围需用户授权。",
            "超时/取消沿用 request_id，建房另带原 database_id/generation；世代或历史分歧先核对合同，不自动改绑。",
            "仅阶段完成、缺陷或待决事项发帖，默认 1–3 行：结论、引用、下一步；不发收讫、不复述、不轮询。已授权的下一项归自己就继续。",
        ],
        exposure: "model-only",
        executionMode: "sequential",
        annotations: { destructiveHint: false, openWorldHint: false },
        parameters: Type.Object({
            command: StringEnum(commands),
            input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "命令业务字段；身份由 Pi 注入。" })),
            reset: Type.Optional(Type.Boolean({ description: "仅 read：已核对恢复状态，重置统一阅读位置。" })),
        }),
        async execute(callId, params, signal, _onUpdate, ctx) {
            return run(callId, params, ctx, signal);
        },
    });
    pi.on("session_shutdown", () => {
        epoch++;
        runner.stop();
    });
}
