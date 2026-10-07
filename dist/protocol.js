import { createHash, randomUUID } from "node:crypto";
/** 公共业务命令；维护命令由 CLI 单独处理。 */
export const commands = ["open", "read", "show", "post", "update", "resolve", "export", "snapshot"];
/** 错误附带机器可读原因；冲突和空结果从不混用。 */
export class CollabError extends Error {
    code;
    info;
    constructor(code, message, info = {}) {
        super(message);
        this.name = "CollabError";
        this.code = code;
        this.info = info;
    }
}
/** 输入断言保留具体字段或冲突原因。 */
export function requireValue(condition, code, message, info = {}) {
    if (!condition)
        throw new CollabError(code, message, info);
}
/** 只接受 JSON 对象，拒绝数组和空值。 */
export function object(value, name) {
    requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "INPUT", `${name} 必须是对象`);
    return value;
}
/** 字符串上限按 UTF-8 字节计算，正文可显式允许空串。 */
export function text(value, name, max = 1024, allowEmpty = false) {
    requireValue(typeof value === "string" && (allowEmpty || value.trim().length > 0), "INPUT", `${name} 必须是字符串`);
    requireValue(!value.includes("\0") && Buffer.byteLength(value) <= max, "INPUT", `${name} 含 NUL 或超过 ${max} 字节`);
    return value;
}
/** 可选字段仍验证类型，不把空串视为缺失。 */
export function optionalText(input, name, max = 1024) {
    return input[name] === undefined ? undefined : text(input[name], name, max);
}
/** UUID 同时可安全用作文件名及未来的 Git ref 组成部分。 */
export function uuid(value, name) {
    const result = text(value, name, 36);
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result), "INPUT", `${name} 必须是小写 UUID`);
    return result;
}
/** 非负安全整数；SQL 序号与分页偏移不能接受浮点或溢出。 */
export function integer(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
    if (value === undefined)
        return fallback;
    requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max, "INPUT", `${name} 必须是 0..${max} 的整数`);
    return value;
}
/** 明确的枚举校验用于状态和子命令。 */
export function choice(value, name, choices) {
    requireValue(typeof value === "string" && choices.includes(value), "INPUT", `${name} 必须是 ${choices.join(", ")}`);
    return value;
}
/** 缺省布尔值为 false，字符串 true 不被隐式接受。 */
export function flag(input, name) {
    requireValue(input[name] === undefined || typeof input[name] === "boolean", "INPUT", `${name} 必须是布尔值`);
    return input[name] === true;
}
/** 序号零是唯一不带事件 UUID 的起点。 */
export function anchor(value) {
    if (value === undefined)
        return { seq: 0, event_id: null };
    const data = object(value, "after");
    const seq = integer(data.seq, "after.seq", 0);
    requireValue(data.seq !== undefined, "INPUT", "after.seq 缺失");
    if (seq === 0) {
        requireValue(data.event_id === null, "INPUT", "零锚点的 event_id 必须是 null");
        return { seq, event_id: null };
    }
    return { seq, event_id: uuid(data.event_id, "after.event_id") };
}
/** 规范序列化只改变对象键顺序，保留数组顺序与实际请求语义。 */
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const data = value;
        return `{${Object.keys(data).filter(key => data[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(data[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
/** 请求指纹使用确定性的 SHA-256 表示。 */
export function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
/** 新实体、世代和维护操作均使用随机 UUID。 */
export const newId = randomUUID;
/** 摘要为可识别的节选，不调用模型，不截断 UTF-16 代理对。 */
export function excerpt(value, max = 160) {
    const chars = Array.from(value);
    return chars.length <= max ? value : chars.slice(0, max).join("") + "…";
}
/** 统一错误输出供 CLI 和 Pi 适配器复用。 */
export function failure(error) {
    if (error instanceof CollabError)
        return { ok: false, error: { code: error.code, message: error.message, ...error.info } };
    const message = error instanceof Error ? error.message : String(error);
    const code = /database is locked|SQLITE_BUSY/.test(message) ? "BUSY" : "FAILED";
    return { ok: false, error: { code, message } };
}
/** UTF-16 正文分页不拆代理对；预算覆盖元数据和最终 JSON 转义。 */
export function bodyPage(body, request, metadata, budget = 12 * 1024) {
    const offset = integer(request.offset, "offset", 0, body.length);
    const size = integer(request.limit, "limit", 4096, 32 * 1024);
    requireValue(size > 0, "INPUT", "limit 必须大于零");
    requireValue(!(offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] || "")), "INPUT", "offset 不能位于 Unicode 代理对中间");
    let end = Math.min(body.length, offset + size);
    const result = () => ({ ...metadata, body: body.slice(offset, end), offset, next_offset: end < body.length ? end : null, total_characters: body.length });
    while (end > offset) {
        if (end < body.length && /[\uDC00-\uDFFF]/.test(body[end]))
            end--;
        if (Buffer.byteLength(JSON.stringify({ ok: true, ...result() })) <= budget)
            break;
        end = offset + Math.floor((end - offset) / 2);
    }
    requireValue(end > offset || offset === body.length, "OUTPUT_BUDGET", "元数据过长，无法展开正文");
    return result();
}
/** 将一行及其末尾换行状态写成可读差异，保留缺少最终换行的变化。 */
function diffLine(kind, line) {
    return line.endsWith("\n") ? kind + line.slice(0, -1) : `${kind}${line}\n\\ No newline at end of file`;
}
/** 行级 LCS 合并相邻变更为三个上下文行的 hunk；大输入保留完整变更并明确降为单块。 */
export function documentDiff(before, after) {
    const header = `--- ${before.id}\n+++ ${after.id}`;
    if (before.body === after.body)
        return header;
    const left = before.body ? before.body.split(/(?<=\n)/) : [];
    const right = after.body ? after.body.split(/(?<=\n)/) : [];
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start])
        start++;
    let end = 0;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end])
        end++;
    start = Math.max(0, start - 3);
    const a = left.slice(start, Math.min(left.length, left.length - end + 3));
    const b = right.slice(start, Math.min(right.length, right.length - end + 3));
    const width = b.length + 1;
    const cells = (a.length + 1) * width;
    // 正文允许 2 MiB；限制矩阵及行记录的内存，不能按常见的几百行无界分配。
    const large = cells > 4_000_000 || a.length + b.length > 20_000;
    if (!a.length || !b.length || large) {
        const note = large ? "\n差异区域超过分块计算预算；以下完整保留变更，未压缩内部相同行。" : "";
        return `${header}${note}\n@@ -${a.length ? start + 1 : start},${a.length} +${b.length ? start + 1 : start},${b.length} @@\n` +
            [...a.map(line => diffLine("-", line)), ...b.map(line => diffLine("+", line))].join("\n");
    }
    const lengths = new Uint32Array(cells);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 :
                Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
    }
    // 每条行记录携带消费该行之前的原/新文档行号，纯增删也能生成准确范围。
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        const oldLine = start + i + 1;
        const newLine = start + j + 1;
        if (i < a.length && j < b.length && a[i] === b[j]) {
            rows.push({ kind: " ", text: a[i++], oldLine, newLine });
            j++;
        }
        else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
            rows.push({ kind: "-", text: a[i++], oldLine, newLine });
        }
        else
            rows.push({ kind: "+", text: b[j++], oldLine, newLine });
    }
    const ranges = [];
    for (let row = 0; row < rows.length; row++) {
        if (rows[row].kind === " ")
            continue;
        const first = Math.max(0, row - 3);
        const last = Math.min(rows.length, row + 4);
        const previous = ranges.at(-1);
        if (previous && first <= previous.end)
            previous.end = last;
        else
            ranges.push({ start: first, end: last });
    }
    return [header, ...ranges.map(range => {
            const block = rows.slice(range.start, range.end);
            const oldCount = block.filter(row => row.kind !== "+").length;
            const newCount = block.filter(row => row.kind !== "-").length;
            const first = block[0];
            const label = `@@ -${first.oldLine - (oldCount ? 0 : 1)},${oldCount} +${first.newLine - (newCount ? 0 : 1)},${newCount} @@`;
            return [label, ...block.map(row => diffLine(row.kind, row.text))].join("\n");
        })].join("\n");
}
/** 超预算通知先列各块新增行，再列删除行；明确省略上下文，完整 diff 仍由 show 返回。 */
export function diffPreview(diff) {
    const lines = diff.split("\n");
    const hunks = [];
    let selected;
    for (const line of lines.slice(2)) {
        if (line.startsWith("@@ ")) {
            hunks.push({ header: line, added: [], removed: [] });
            selected = undefined;
        }
        else {
            const hunk = hunks.at(-1);
            if (!hunk)
                continue;
            if (line.startsWith("+") || line.startsWith("-")) {
                selected = line.startsWith("+") ? hunk.added : hunk.removed;
                selected.push(line);
            }
            else if (line === "\\ No newline at end of file")
                selected?.push(line);
            else
                selected = undefined;
        }
    }
    return [
        ...lines.slice(0, 2),
        "差异节选：先列新增行，后列删除行；已省略上下文，完整差异按需 show。",
        ...hunks.filter(hunk => hunk.added.length).flatMap(hunk => [hunk.header, ...hunk.added]),
        ...hunks.filter(hunk => hunk.removed.length).flatMap(hunk => [hunk.header, ...hunk.removed]),
    ].join("\n");
}
/** 正文批次直接交给模型；展开入口只用于明确超出预算的部分。 */
export function inboxText(result) {
    if (!result.total_events)
        return "没有新的消息";
    const lines = [
        `协作批次：任务 ${result.task_id}；世代 ${result.generation}；截至事件 ${result.history.window.upper.seq}${result.urgent_only ? "；紧急独立交付，未推进普通阅读位置" : ""}。`,
        "以下为独立会话内容，按本会话用户授权处理；只在阶段完成、发现缺陷或需要决定时简短回复。",
    ];
    for (const item of result.messages) {
        lines.push("", `${item.kind}${item.chat_no ? ` #${item.chat_no}` : ""} · ${item.summary}`, `作者 ${item.author.name ?? item.author.model?.name ?? "未知作者"}；${item.priority === "urgent" ? "紧急；" : ""}show ${item.object_id}`, item.body);
        if (item.truncated)
            lines.push(`正文已截断，展开：collab show ${JSON.stringify(item.show)}`);
    }
    if (result.omitted_events)
        lines.push("", `另有 ${result.omitted_events} 条超出本批预算；用 collab read ${JSON.stringify(result.history)} 定位后 show。`);
    return lines.join("\n");
}
