import type { Store } from "./database.ts";
import type { Request } from "./protocol.ts";
import { flag, integer, requireValue, text } from "./protocol.ts";
import { resolveProject } from "./routing.ts";

/** 菜单只展示公开房间信息；同名项始终携带稳定 UUID。 */
export interface RoomRow {
  task_id: string; project_id: string; project: string; title: string; status: string;
  updated_at: string; members: string; local: boolean;
}

/** 状态已初始化后以状态版本为准，初始化前使用建房合同状态。 */
export const roomStatusSql = "coalesce((SELECT json_extract(state,'$.status') FROM progress_revisions WHERE task_id=t.id ORDER BY version DESC LIMIT 1),r.status)";

/** 项目定位不登记新项目；建房时由写事务登记，列表读取无持久副作用。 */
export function localProject(store: Store, request: Request): { id?: string; root: string } {
  const location = resolveProject(store, request);
  if ("id" in location) return store.one<{ id: string; root: string }>("SELECT id,root FROM projects WHERE id=?", location.id)!;
  return { id: store.one<{ id: string }>("SELECT id FROM projects WHERE locator=?", location.locator)?.id, root: location.root };
}

/** 精确匹配及近似候选在服务端判断；分页不把未展示的匹配当作不存在。 */
export function discoverRooms(store: Store, request: Request): Record<string, unknown> {
  const local = localProject(store, request);
  const lookup = request.topic !== undefined;
  const topic = lookup ? text(request.topic, "topic", 512).trim() : "";
  const localId = local.id ?? "";
  const base = `FROM tasks t JOIN revisions r ON r.id=t.current_revision JOIN projects p ON p.id=t.project_id WHERE 1=1`;
  const columns = `t.id AS task_id,t.project_id,p.root AS project,r.title,${roomStatusSql} AS status,
    coalesce((SELECT max(updated_at) FROM members WHERE task_id=t.id),r.created_at) AS updated_at,
    (SELECT json_group_array(name) FROM (SELECT name FROM members WHERE task_id=t.id ORDER BY name LIMIT 10)) AS members,
    t.project_id=? AS local`;
  let clause = "";
  let values: (string | number)[] = [];
  let decision = "select";
  let knownTopics: string[] = [];
  if (lookup) {
    const exact = store.all<{ task_id: string; project_id: string; status: string }>(`SELECT t.id AS task_id,t.project_id,${roomStatusSql} AS status ${base} AND r.title=?`, topic);
    const own = exact.filter(row => row.project_id === localId);
    knownTopics = own.map(row => row.task_id);
    if (own.length) {
      clause = " AND t.project_id=? AND r.title=?"; values = [localId, topic];
      if (own.length === 1 && own[0].status !== "completed") decision = "join";
    } else if (exact.length) { clause = " AND r.title=?"; values = [topic]; }
    else {
      clause = " AND t.project_id=? AND (instr(lower(r.title),lower(?))>0 OR instr(lower(?),lower(r.title))>0)";
      values = [localId, topic, topic];
      const total = store.one<{ n: number }>(`SELECT count(*) AS n ${base}${clause}`, ...values)!.n;
      if (!total) decision = "create";
    }
  } else {
    if (!flag(request, "all_projects")) { clause += " AND t.project_id=?"; values.push(localId); }
    if (!flag(request, "include_completed")) clause += ` AND ${roomStatusSql}<>'completed'`;
    if (request.search !== undefined) {
      clause += " AND instr(lower(r.title),lower(?))>0";
      values.push(text(request.search, "search", 512, true));
    }
  }
  const offset = integer(request.rooms_offset, "rooms_offset", 0);
  const total = store.one<{ n: number }>(`SELECT count(*) AS n ${base}${clause}`, ...values)!.n;
  const rooms = store.all<RoomRow>(`SELECT ${columns} ${base}${clause} ORDER BY local DESC,updated_at DESC,t.id LIMIT 20 OFFSET ?`, localId, ...values, offset);
  return { rooms: rooms.map(row => ({ ...row, local: !!row.local, members: JSON.parse(row.members) })), total,
    rooms_offset: offset, next_offset: offset + rooms.length < total ? offset + rooms.length : null,
    decision, topic: lookup ? topic : undefined, project_id: local.id, project_root: local.root, known_topics: knownTopics };
}

/** 建房门禁内再次检查同名项；菜单已确认的旧同名项与并发新建分开。 */
export function concurrentRoom(store: Store, projectId: string, request: Request): string | undefined {
  if (request.topic_create !== true) return undefined;
  const known = request.known_topics ?? [];
  requireValue(Array.isArray(known) && known.length <= 1000 && known.every(id => typeof id === "string"), "INPUT", "known_topics 必须为菜单返回的任务 ID 列表");
  const matches = store.all<{ id: string; status: string }>(`SELECT t.id,${roomStatusSql} AS status FROM tasks t JOIN revisions r ON r.id=t.current_revision WHERE t.project_id=? AND r.title=?`, projectId, text(request.title, "title", 512));
  const fresh = matches.filter(row => !known.includes(row.id));
  if (!fresh.length) return undefined;
  requireValue(fresh.length === 1 && fresh[0].status !== "completed", "TOPIC_CHANGED", "候选主题已变化，请重新选择", { tasks: fresh });
  return fresh[0].id;
}
