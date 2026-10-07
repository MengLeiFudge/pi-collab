import type { Store } from "./database.ts";
import { beginWrite, finishWrite } from "./writes.ts";
import { CollabError, choice, newId, requireValue, text, uuid } from "./protocol.ts";
import type { Request } from "./protocol.ts";
import { SnapshotGit, objectId, snapshotScope } from "./snapshot-git.ts";
import type { GitProject, GitSnapshot, SnapshotPlan } from "./snapshot-git.ts";

/** 意图在采集前保留，registered 才表示 ref 与数据库登记均已完成。 */
export interface SnapshotRow {
  id: string; task_id: string; generation: string; client: string; session_id: string; request_id: string;
  fingerprint: string; plan: string; state: "prepared" | "registered"; objects: string | null;
  author: string; event_seq: number | null; created_at: string;
}

/** show 和系统事件返回固定对象描述；不隐式运行 Git 或把它当作当前工作区。 */
export function snapshotView(row: SnapshotRow): Record<string, unknown> {
  return { snapshot_id: row.id, state: row.state, plan: JSON.parse(row.plan), objects: row.objects ? JSON.parse(row.objects) : null,
    event_seq: row.event_seq, author: JSON.parse(row.author), registered_at: row.state === "registered" ? row.created_at : null };
}

/** Git I/O 在事务外，最终登记重新检查所有写前提；重试不重新采样。 */
export async function snapshot(store: Store, request: Request, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const initial = store.atomic(false, () => {
    const context = beginWrite(store, request);
    const prior = store.one<SnapshotRow>("SELECT * FROM snapshots WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?",
      context.task.id, context.generation, request.client, request.session_id, context.requestId);
    const project = store.one<GitProject>("SELECT locator,git,root FROM projects WHERE id=?", context.task.project_id)!;
    return { context, prior, project, databaseId: store.metadata().database_id };
  });
  if (initial.context.prior) return initial.context.prior;
  const mode = choice(request.mode ?? "create", "mode", ["create", "register"]);
  const worktree = text(request.worktree, "worktree", 4096);
  const scope = snapshotScope(request.scope);
  requireValue(mode === "register" || ["snapshot_id", "ref", "base", "commit"].every(key => request[key] === undefined), "INPUT", "create 的快照身份和 base 由插件固定，不接受登记字段");
  const git = new SnapshotGit(initial.project, worktree, signal);
  const location = await git.locate(initial.project);
  let row = initial.prior;
  let fresh = false;
  if (!row) {
    const id = mode === "register" ? uuid(request.snapshot_id, "snapshot_id") : newId();
    const ref = `refs/collab/${initial.context.generation}/${initial.context.task.id}/${id}`;
    if (mode === "register") requireValue(request.ref === ref, "SNAPSHOT_REF", "登记 ref 必须与本世代、任务和 snapshot_id 对应", { ref });
    const base = mode === "register" ? objectId(request.base, "base") : objectId((await git.run(["rev-parse", "--verify", "HEAD^{commit}"])).trim(), "base");
    const plan: SnapshotPlan = { id, database_id: initial.databaseId, generation: initial.context.generation, task_id: initial.context.task.id,
      fingerprint: initial.context.fingerprint, git: git.git, worktree: location.worktree, common_dir: location.common, scope, base, ref,
      source: mode === "register" ? "external" : "worktree", ...(mode === "register" ? { expected_commit: objectId(request.commit, "commit") } : {}), created_at: new Date().toISOString() };
    const reserved = store.atomic(true, () => {
      const context = beginWrite(store, request);
      const existing = store.one<SnapshotRow>("SELECT * FROM snapshots WHERE task_id=? AND generation=? AND client=? AND session_id=? AND request_id=?",
        context.task.id, context.generation, request.client, request.session_id, context.requestId);
      if (existing) return { row: existing, fresh: false };
      requireValue(!context.prior, "REQUEST_CONFLICT", "请求已被另一操作提交");
      requireValue(!store.one("SELECT id FROM snapshots WHERE id=?", id), "SNAPSHOT_CONFLICT", "snapshot_id 已被其他请求使用");
      store.run("INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, context.task.id, context.generation, request.client, request.session_id, context.requestId,
        context.fingerprint, JSON.stringify(plan), "prepared", null, context.author, null, plan.created_at);
      return { row: store.one<SnapshotRow>("SELECT * FROM snapshots WHERE id=?", id)!, fresh: true };
    });
    row = reserved.row; fresh = reserved.fresh;
  }
  const plan = JSON.parse(row.plan) as SnapshotPlan;
  requireValue(plan.worktree === location.worktree && plan.common_dir === location.common && plan.git === git.git, "PROJECT", "原快照意图的工作树或主 Git 已变化，不能重新采样");
  let objects: GitSnapshot;
  try {
    if (fresh && mode === "create") await git.capture(plan);
    objects = await git.verify(plan);
  } catch (error) {
    const info = { request_id: initial.context.requestId, snapshot_id: row.id, ref: plan.ref, show: { object_id: row.id } };
    if (error instanceof CollabError) { error.info = { ...error.info, ...info }; throw error; }
    throw new CollabError("SNAPSHOT", error instanceof Error ? error.message : String(error), info);
  }
  requireValue(!signal?.aborted, "CANCELLED", "Git 对象已固定但登记被取消；复用原 request_id 接续", { snapshot_id: row.id, ref: plan.ref });
  return store.atomic(true, () => {
    const context = beginWrite(store, request);
    if (context.prior) return context.prior;
    const pending = store.one<SnapshotRow>("SELECT * FROM snapshots WHERE id=?", row!.id);
    requireValue(pending && pending.state === "prepared" && pending.fingerprint === context.fingerprint && pending.generation === context.generation, "SNAPSHOT_CHANGED", "采集意图已变化或不在当前世代，保留 Git ref 供核对");
    const event = store.event(context.task, "snapshotted", row!.id, `Git 审阅快照 ${objects.commit.slice(0, 12)}；${plan.scope.join("、")}`, context.author);
    store.run("UPDATE snapshots SET state='registered',objects=?,event_seq=?,created_at=? WHERE id=?", JSON.stringify(objects), event.seq, new Date().toISOString(), row!.id);
    return finishWrite(store, request, context, { snapshot: snapshotView(store.one<SnapshotRow>("SELECT * FROM snapshots WHERE id=?", row!.id)!), event });
  });
}
