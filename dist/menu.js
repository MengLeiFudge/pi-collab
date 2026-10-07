import { copyToClipboard, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { branchState } from "./receiver.js";
import { requireValue, uuid } from "./protocol.js";
/** 使用 Pi 的输入和列表组件，保留主题、宽字符、取消与 IME 焦点行为。 */
async function choose(ctx, title, items) {
    requireValue(ctx.mode === "tui", "UI_REQUIRED", "主题有歧义或需要菜单；请在交互 Pi 选择，或用 /collab join <UUID> 明确加入", { candidates: items });
    return ctx.ui.custom((tui, theme, keys, done) => {
        const input = new Input({ prompt: "搜索：", placeholder: "主题 / 项目 / 模型；Esc 取消" });
        const heading = new Text(theme.fg("accent", title), 0, 0);
        let list;
        const refresh = () => {
            const needle = input.getValue().trim().toLocaleLowerCase();
            list = new SelectList(items.filter(item => item.value.startsWith(":") || `${item.label} ${item.description ?? ""}`.toLocaleLowerCase().includes(needle)), 12, getSelectListTheme());
            list.onSelect = item => done({ value: item.value, search: input.getValue().trim() });
            list.onCancel = () => done(undefined);
        };
        refresh();
        return {
            get focused() { return input.focused; }, set focused(value) { input.focused = value; },
            render(width) { return [...heading.render(width), ...input.render(width), ...list.render(width)]; },
            invalidate() { heading.invalidate(); input.invalidate(); list.invalidate(); },
            handleInput(data) {
                if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") || matchesKey(data, Key.enter) || matchesKey(data, Key.escape))
                    list.handleInput(data);
                else {
                    input.handleInput(data);
                    refresh();
                }
                tui.requestRender();
            },
        };
    });
}
/** 主题命令只有当前项目唯一精确匹配才直接加入；近似和跨项目先选。 */
export function roomCommand(invoke, run, epoch) {
    return async (args, ctx) => {
        let selected = branchState(ctx).selected;
        const scope = epoch();
        const session = ctx.sessionManager.getSessionId();
        const check = () => requireValue(scope === epoch() && session === ctx.sessionManager.getSessionId(), "CONTEXT_CHANGED", "菜单打开期间会话或模型已变化，请重新打开 /collab");
        const query = async (fields) => {
            check();
            const result = await invoke("open", { action: "rooms", project_root: ctx.cwd, ...fields, client: "pi", session_id: ctx.sessionManager.getSessionId() }, ctx);
            check();
            if (!result.ok && !selected && result.error?.code === "NOT_INITIALIZED" && result.error.message.includes("尚未初始化"))
                return { rooms: [], total: 0, next_offset: null, decision: "create", known_topics: [], project_root: ctx.cwd };
            requireValue(result.ok, "ROOMS", JSON.stringify(result.error));
            return result;
        };
        const join = async (id, rejoin = false) => { check(); await run({ command: "open", input: { task_id: uuid(id, "task_id"), rejoin } }, ctx); };
        const create = async (name, discovery) => {
            check();
            requireValue(name.trim(), "INPUT", "主题不能为空");
            await run({ command: "open", input: { create: true, title: name.trim(), body: `# ${name.trim()}\n`, project_root: ctx.cwd,
                    topic_create: true, known_topics: discovery.known_topics } }, ctx);
        };
        const options = (rooms) => rooms.map(room => ({ value: room.task_id, label: room.title,
            description: `${room.project} · ${room.status} · ${room.members.join("、") || "暂无成员"} · ${room.task_id.slice(0, 8)}` }));
        const topic = async (name, forceChoice = false) => {
            let offset = 0;
            for (;;) {
                const result = await query({ topic: name, rooms_offset: offset });
                if (!forceChoice && result.decision === "join") {
                    await join(result.rooms[0].task_id);
                    return;
                }
                if (result.decision === "create") {
                    await create(name, result);
                    return;
                }
                const choice = await choose(ctx, `选择主题或在当前项目新建“${name}”`, [...options(result.rooms),
                    { value: ":new", label: `新建 ${name}`, description: ctx.cwd },
                    ...(result.next_offset === null ? [] : [{ value: ":next", label: "更多候选" }]),
                    ...(offset ? [{ value: ":first", label: "回到第一页" }] : [])]);
                if (!choice)
                    return;
                if (choice.value === ":next") {
                    offset = result.next_offset;
                    continue;
                }
                if (choice.value === ":first") {
                    offset = 0;
                    continue;
                }
                if (choice.value === ":new")
                    await create(name, result);
                else
                    await join(choice.value);
                return;
            }
        };
        const copyInvite = async () => {
            check();
            requireValue(selected, "JOIN_REQUIRED", "尚未选择主题");
            const result = await run({ command: "open", inspect: true, input: { task_id: selected.task_id, action: "invite" } }, ctx);
            check();
            const value = result.details.result;
            requireValue(!result.isError && typeof value?.invitation === "string", "INVITE", "邀请生成失败");
            await copyToClipboard(value.invitation);
            ctx.ui.notify("已复制自然语言邀请，可粘贴给新会话并补充分工", "info");
        };
        const scopes = async () => {
            let after;
            for (;;) {
                check();
                const result = await run({ command: "read", input: { view: "assignments", all_rooms: true, assignments_after: after } }, ctx);
                check();
                requireValue(!result.isError, "ASSIGNMENTS", result.content[0].text);
                const data = result.details.result;
                const picked = await choose(ctx, "写入登记（全部房间）· 选择后可解除", [
                    ...data.assignments.map(row => ({ value: row.assignment_id, label: `${row.title} · ${row.member} · ${row.state}`, description: `${row.stage} · ${row.workspace}` })),
                    ...(data.assignments_after ? [{ value: ":next", label: "下一页" }] : []),
                ]);
                if (!picked)
                    return;
                if (picked.value === ":next") {
                    after = data.assignments_after;
                    continue;
                }
                const row = data.assignments.find(row => row.assignment_id === picked.value);
                const detail = await invoke("show", { task_id: row.task_id, object_id: row.id, client: "pi", session_id: session }, ctx);
                check();
                requireValue(detail.ok && detail.assignment, "ASSIGNMENTS", JSON.stringify(detail.error));
                const assignment = detail.assignment;
                const reason = await ctx.ui.input("解除原因（仅释放登记，不会停止旧命令）", "确认旧写入结束，或说明明确接管的原因");
                check();
                if (!reason?.trim())
                    return;
                if (!await ctx.ui.confirm("解除写入登记", `${row.title} / ${row.member} / ${row.stage}\n${assignment.workspace}\n${assignment.scopes.join("\n")}\n解除不会取消任何进程。确认解除？`))
                    return;
                check();
                await run({ command: "open", inspect: true, userAction: true, input: { action: "release-scopes", assignment: { action: "user-release", user_authorized: true, reason,
                            targets: [{ id: row.assignment_id, base_assignment: row.id }] } } }, ctx);
                return;
            }
        };
        const settings = async () => {
            selected = branchState(ctx).selected;
            requireValue(selected, "JOIN_REQUIRED", "尚未加入主题");
            const item = await choose(ctx, `房间设置：${selected.title ?? "当前主题"}`, [
                { value: ":info", label: "查看成员与房间概况" }, { value: ":copy", label: "复制自然语言邀请" }, { value: ":scopes", label: "查看/解除写入登记（全部房间）" },
                { value: ":on", label: "开启忙碌时紧急通知" }, { value: ":off", label: "关闭忙碌时紧急通知" },
                { value: ":leave", label: "离开当前房间" }, { value: ":rejoin", label: "明确重新接替当前模型身份" },
            ]);
            if (!item)
                return;
            check();
            if (item.value === ":copy")
                await copyInvite();
            else if (item.value === ":scopes")
                await scopes();
            else if (item.value === ":rejoin")
                await join(selected.task_id, true);
            else if (item.value === ":info")
                await run({ command: "open", inspect: true }, ctx);
            else
                await run({ command: "open", inspect: true, userAction: true, input: { task_id: selected.task_id,
                        action: item.value === ":leave" ? "leave" : "preferences", ...(item.value === ":leave" ? {} : { urgent_enabled: item.value === ":on" }) } }, ctx);
        };
        const trimmed = args.trim();
        if (trimmed) {
            const [action, ...rest] = trimmed.split(/\s+/);
            if (action === "join" || action === "rejoin") {
                requireValue(rest.length <= 1, "INPUT", "加入只接受一个 UUID");
                await join(rest[0] ?? (action === "rejoin" ? selected?.task_id ?? "" : ""), action === "rejoin");
            }
            else if (action === "new" || action === "建房") {
                requireValue(rest.length, "INPUT", "请输入主题");
                await topic(rest.join(" "), true);
            }
            else if (trimmed === "info")
                await run({ command: "open", inspect: true }, ctx);
            else if (trimmed === "copy")
                await copyInvite();
            else if (trimmed === "scopes")
                await scopes();
            else if (/^[0-9a-f-]{36}$/.test(trimmed))
                await join(trimmed);
            else
                await topic(trimmed);
            return;
        }
        let all = false, completed = false, offset = 0, search = "";
        for (;;) {
            selected = branchState(ctx).selected;
            const result = await query({ all_projects: all, include_completed: completed, rooms_offset: offset, search });
            const item = await choose(ctx, `讨论主题 · ${all ? "全部项目" : "当前项目"} · ${result.total} 个${selected ? ` · 当前：${selected.title ?? "已加入"}` : ""}`, [
                ...options(result.rooms), { value: ":new", label: "创建主题" }, { value: ":search", label: "用搜索框文字查询全部匹配主题", description: "包含未加载的其他页" },
                { value: ":all", label: all ? "只看当前项目" : "查看全部项目" }, { value: ":completed", label: completed ? "隐藏已完成主题" : "显示已完成主题" },
                ...(result.next_offset === null ? [] : [{ value: ":next", label: "下一页" }]), ...(offset ? [{ value: ":first", label: "回到第一页" }] : []),
                ...(selected ? [{ value: ":settings", label: "当前房间设置" }] : []),
            ]);
            if (!item)
                return;
            if (item.value === ":settings") {
                await settings();
                continue;
            }
            if (item.value === ":all") {
                all = !all;
                offset = 0;
                continue;
            }
            if (item.value === ":completed") {
                completed = !completed;
                offset = 0;
                continue;
            }
            if (item.value === ":search") {
                search = item.search;
                offset = 0;
                continue;
            }
            if (item.value === ":next") {
                offset = result.next_offset;
                continue;
            }
            if (item.value === ":first") {
                offset = 0;
                continue;
            }
            if (item.value === ":new") {
                const name = await ctx.ui.input("新主题名称", item.search || "例如：登录模块审阅");
                if (name?.trim())
                    await topic(name.trim(), true);
            }
            else
                await join(item.value);
            return;
        }
    };
}
