import { currentMember, publicAuthor, recordQuery } from "./members.js";
import { choice, excerpt, integer, object, requireValue, text, uuid } from "./protocol.js";
/** 有选择器才进入自由查询；默认 read 继续服务未读收件。 */
export function hasQuery(request) {
    return request.view === "messages" || ["latest", "range", "author", "keyword", "matches", "query_window"].some(key => request[key] !== undefined);
}
/** 区间必须明确提供两个正整数端点；匹配排名和房间编号分别使用它。 */
function interval(value, name) {
    const data = object(value, name);
    const from = integer(data.from, `${name}.from`, 0);
    const to = integer(data.to, `${name}.to`, 0);
    requireValue(from > 0 && to >= from, "INPUT", `${name} 需要 1 <= from <= to`);
    return { from, to };
}
/** 作者按模型全名或成员 UUID 精确匹配，并核对所属房间。 */
function authorFilter(store, task, value) {
    if (value === undefined)
        return undefined;
    if (typeof value === "string") {
        const name = text(value, "author", 512);
        const member = store.one("SELECT id FROM members WHERE task_id=? AND name=?", task.id, name);
        requireValue(member, "NOT_FOUND", "没有该名称的成员；可用成员 UUID 筛选");
        return { member_id: member.id };
    }
    const data = object(value, "author");
    const id = uuid(data.member_id, "author.member_id");
    requireValue(store.one("SELECT id FROM members WHERE task_id=? AND id=?", task.id, id), "NOT_FOUND", "成员不属于此房间");
    return { member_id: id };
}
/** 固定 SQL 片段配合参数绑定；关键词中的百分号、下划线和反斜杠按字面匹配。 */
function filter(task, window) {
    const clauses = ["task_id=?", "event_seq<=?"];
    const values = [task.id, window.upper.seq];
    if (window.author) {
        clauses.push("member_id=?");
        values.push(window.author.member_id);
    }
    if (window.keyword !== undefined) {
        const match = `%${window.keyword.replace(/[\\%_]/g, "\\$&")}%`;
        clauses.push("(summary LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
        values.push(match, match);
    }
    if (window.range) {
        clauses.push("chat_no>=?", "chat_no<=?");
        values.push(window.range.from, window.range.to);
    }
    return { sql: clauses.join(" AND "), values };
}
/** 单页最多十条；过滤集合和排名在同一快照中读取，后续页沿用上界。 */
export function readChats(store, task, request, track = true) {
    requireValue(request.view === undefined || ["content", "messages"].includes(String(request.view)), "INPUT", "自由查询不能与事件索引混用");
    const budget = integer(request.max_bytes, "max_bytes", 12 * 1024, 64 * 1024);
    requireValue(budget >= 4096, "INPUT", "max_bytes 至少为 4096");
    const limit = integer(request.limit, "limit", 10, 10);
    requireValue(limit > 0, "INPUT", "每页 limit 为 1..10");
    const meta = store.metadata();
    let window;
    let latest;
    let matches;
    if (request.query_window !== undefined) {
        requireValue(!["latest", "range", "author", "keyword", "matches"].some(key => request[key] !== undefined), "INPUT", "续页时使用 next，不另行修改查询选择器");
        const data = object(request.query_window, "query_window");
        requireValue(data.database_id === meta.database_id && data.generation === meta.generation && data.task_id === task.id, "GENERATION_CHANGED", "查询窗口身份或世代不匹配");
        window = {
            database_id: meta.database_id, generation: meta.generation, task_id: task.id,
            upper: store.checkAnchor(task, data.upper), author: authorFilter(store, task, data.author),
            keyword: data.keyword === undefined ? undefined : text(data.keyword, "keyword", 1024),
            range: data.range === undefined ? undefined : interval(data.range, "range"),
            first: integer(data.first, "query_window.first", 0), last: integer(data.last, "query_window.last", 0),
            next_rank: integer(data.next_rank, "query_window.next_rank", 0),
            direction: choice(data.direction, "query_window.direction", ["forward", "backward"]),
        };
        requireValue(window.first > 0 && window.last >= window.first && window.next_rank >= window.first && window.next_rank <= window.last, "INPUT", "查询续页排名无效");
    }
    else {
        requireValue([request.latest, request.range, request.matches].filter(value => value !== undefined).length <= 1, "INPUT", "latest/range/matches 是互斥的位置选择");
        const last = store.one("SELECT id FROM events WHERE task_id=? AND seq=?", task.id, task.event_seq);
        latest = request.range === undefined && request.matches === undefined ? integer(request.latest, "latest", 10) : undefined;
        requireValue(latest === undefined || latest > 0, "INPUT", "latest 必须大于零");
        matches = request.matches === undefined ? undefined : interval(request.matches, "matches");
        window = {
            database_id: meta.database_id, generation: meta.generation, task_id: task.id,
            upper: { seq: task.event_seq, event_id: last?.id ?? null }, author: authorFilter(store, task, request.author),
            keyword: request.keyword === undefined ? undefined : text(request.keyword, "keyword", 1024),
            range: request.range === undefined ? undefined : interval(request.range, "range"),
            first: 1, last: 0, next_rank: 0, direction: latest === undefined ? "forward" : "backward",
        };
    }
    const query = filter(task, window);
    const total = store.one(`SELECT count(*) AS n FROM messages WHERE ${query.sql}`, ...query.values).n;
    if (request.query_window === undefined) {
        window.first = latest === undefined ? matches?.from ?? 1 : Math.max(1, total - latest + 1);
        window.last = Math.min(total, matches?.to ?? total);
        window.next_rank = window.direction === "backward" ? window.last : window.first;
    }
    else
        requireValue(window.last <= total, "HISTORY_DIVERGED", "查询匹配集合已变化，请重新查询");
    const authorQuery = filter(task, { upper: window.upper, author: window.author });
    const authorTotal = window.author ? store.one(`SELECT count(*) AS n FROM messages WHERE ${authorQuery.sql}`, ...authorQuery.values).n : undefined;
    const first = window.direction === "forward" ? window.next_rank : window.first;
    const last = window.direction === "backward" ? window.next_rank : window.last;
    const rows = window.first > window.last ? [] : store.all(`SELECT * FROM (SELECT *,row_number() OVER (ORDER BY chat_no) AS rank FROM messages WHERE ${query.sql}) WHERE rank>=? AND rank<=? ORDER BY rank ${window.direction === "forward" ? "ASC" : "DESC"} LIMIT ?`, ...query.values, first, last, limit);
    const messages = rows.map(row => ({
        id: row.id, chat_no: row.chat_no, event_seq: row.event_seq, rank: row.rank, author: publicAuthor(row.author),
        summary: excerpt(row.summary), body: "", truncated: row.body.length > 0,
        reply_to: row.reply_to ? { kind: "message", id: row.reply_to } : row.reply_revision ? { kind: "revision", id: row.reply_revision } : null,
        show: { object_id: row.id },
    }));
    const result = () => {
        const end = messages.at(-1)?.rank;
        const rank = end === undefined ? undefined : window.direction === "forward" ? end + 1 : end - 1;
        const more = rank !== undefined && rank >= window.first && rank <= window.last;
        return {
            view: "messages", database_id: meta.database_id, generation: meta.generation, task_id: task.id,
            total_matching: total, author_total: authorTotal, selected_count: Math.max(0, window.last - window.first + 1), window,
            membership_status: currentMember(store, task, request) ? "active" : request.membership ? "superseded" : "read-only",
            messages: [...messages].sort((a, b) => a.chat_no - b.chat_no),
            next: more ? { task_id: task.id, database_id: meta.database_id, generation: meta.generation, view: "messages", query_window: { ...window, next_rank: rank }, limit, max_bytes: budget } : null,
        };
    };
    // 先保证定位和续页能装下，再分配正文；删掉的是遍历方向末端，不会跳过未返回的匹配。
    while (Buffer.byteLength(JSON.stringify({ ok: true, ...result() })) > budget / 2 && messages.length > 1)
        messages.pop();
    for (let i = 0; i < messages.length; i++) {
        const allowance = Math.max(0, Math.floor((budget - Buffer.byteLength(JSON.stringify({ ok: true, ...result() })) - 256) / (messages.length - i)));
        const body = rows[i].body;
        let low = 0;
        let high = body.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (Buffer.byteLength(JSON.stringify(body.slice(0, mid))) - 2 <= allowance)
                low = mid;
            else
                high = mid - 1;
        }
        if (low > 0 && low < body.length && /[\uDC00-\uDFFF]/.test(body[low] || ""))
            low--;
        messages[i].body = body.slice(0, low);
        messages[i].truncated = low < body.length;
    }
    const output = result();
    requireValue(Buffer.byteLength(JSON.stringify({ ok: true, ...output })) <= budget, "OUTPUT_BUDGET", "查询元数据超过预算，请增大 max_bytes");
    if (track)
        recordQuery(store, task, request, window, messages.map(row => ({ id: row.id, chat_no: row.chat_no, rank: row.rank })));
    return output;
}
