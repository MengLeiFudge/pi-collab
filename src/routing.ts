import { accessSync, constants, closeSync, existsSync, fsyncSync, lstatSync, linkSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";
import { isWsl, isWindowsMount, pathKey } from "./paths.ts";
import { spawnSync } from "node:child_process";
import { newId, optionalText, requireValue, uuid } from "./protocol.ts";
import type { Request } from "./protocol.ts";
import type { Store } from "./database.ts";

/** 同目录临时文件加 fsync/rename，完整写入导出正文或元数据。 */
export function atomicFile(path: string, body: string, exclusive = false): void {
  const temp = `${path}.${newId()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    if (exclusive) linkSync(temp, path);
    else {
      const delays = [20, 50, 100, 200];
      for (let attempt = 0;; attempt++) {
        try { renameSync(temp, path); break; }
        catch (error) {
          if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === delays.length) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
        }
      }
    }
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** 主 Git 仅用于项目身份，不写 Git 对象或引用。 */
function gitOutput(git: string, args: string[]): string {
  const result = spawnSync(git, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
  requireValue(!result.error, "GIT", `无法执行仓库主 Git：${result.error?.message ?? git}`);
  requireValue(result.status === 0, "GIT", result.stderr.trim() || `Git exit ${result.status}`);
  return result.stdout.trim();
}

/** Windows 主 Git 的路径在边界转换，仍保留其配置与仓库语义。 */
export function convertPath(path: string, mode: "-u" | "-w"): string {
  requireValue(isWsl, "PATH", "只有 WSL interop 才能转换 Windows Git 路径");
  const result = spawnSync("wslpath", [mode, path], { encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 });
  requireValue(!result.error && result.status === 0, "PATH", `无法转换主 Git 路径：${path}`);
  return result.stdout.trim();
}

/** 写事务前完成只读定位，数据库登记留在建房事务中。 */
export type ProjectLocation = { id: string } | { locator: string; git: string | null; root: string };

/** 找到可执行的 Windows 主 Git；不启动候选进程，也不退回 WSL Git。 */
function windowsGit(): { git?: string; searched: string[] } {
  const fallback = process.platform === "win32" ? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe") : "/mnt/c/Program Files/Git/cmd/git.exe";
  const searched = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, "git.exe")), fallback];
  for (const path of searched) {
    try { accessSync(path, constants.X_OK); return { git: realpathSync(path), searched }; }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return { searched };
}

/** Git 不可用时只允许明确的普通目录退回；仓库标记和裸库均要求主 Git。 */
function hasGitMarker(root: string): boolean {
  for (let path = root;; path = dirname(path)) {
    if (lstatSync(join(path, ".git"), { throwIfNoEntry: false }) ||
      existsSync(join(path, "HEAD")) && existsSync(join(path, "objects")) && existsSync(join(path, "refs"))) return true;
    if (dirname(path) === path) return false;
  }
}

/** 用主 Git 的公共目录或明确的普通目录定位项目。 */
export function resolveProject(store: Store, request: Request): ProjectLocation {
  if (request.project_id !== undefined) {
    const id = uuid(request.project_id, "project_id");
    requireValue(store.one("SELECT id FROM projects WHERE id=?", id), "NOT_FOUND", "项目不存在");
    return { id };
  }
  const suppliedRoot = optionalText(request, "project_root", 4096);
  const root = realpathSync(suppliedRoot || process.cwd());
  const windows = process.platform === "win32" || isWindowsMount(root);
  const explicit = optionalText(request, "git", 4096);
  const bound = store.one<{ git: string | null }>("SELECT git FROM projects WHERE root=?", root)?.git;
  if (suppliedRoot && !hasGitMarker(root) && !process.env.GIT_DIR && !process.env.GIT_WORK_TREE) return { locator: `directory:${pathKey(root)}`, git: null, root };
  const found = windows && !explicit && !bound ? windowsGit() : { git: undefined, searched: [] };
  const git = explicit || bound || (windows ? found.git : "git");
  requireValue(git, "GIT", "未找到仓库主 Git；可通过 input.git 指定绝对路径", { searched: found.searched });
  requireValue(!windows || /git\.exe$/i.test(git), "GIT", "Windows 盘仓库必须使用主 git.exe");
  let locator: string;
  let primary: string | null = git;
  try {
    const common = gitOutput(git, ["-C", isWsl && /\.exe$/i.test(git) ? convertPath(root, "-w") : root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    locator = `git:${pathKey(realpathSync(isWsl && win32.isAbsolute(common) && !common.startsWith("/") ? convertPath(common, "-u") : common))}`;
  } catch (error) {
    requireValue(suppliedRoot && error instanceof Error && /not a git repository/i.test(error.message), "PROJECT", `项目定位失败：${error instanceof Error ? error.message : error}`);
    locator = `directory:${pathKey(root)}`;
    primary = null;
  }
  const existing = store.one<{ git: string | null }>("SELECT git FROM projects WHERE locator=?", locator);
  if (existing?.git && primary !== existing.git && !explicit) {
    const common = gitOutput(existing.git, ["-C", isWsl && /\.exe$/i.test(existing.git) ? convertPath(root, "-w") : root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    requireValue(`git:${pathKey(realpathSync(isWsl && win32.isAbsolute(common) && !common.startsWith("/") ? convertPath(common, "-u") : common))}` === locator, "PROJECT", "既有主 Git 的项目定位已改变");
    primary = existing.git;
  }
  requireValue(!existing || existing.git === primary, "PROJECT", "项目主 Git 与既有登记不同，需要显式维护绑定");
  return { locator, git: primary, root };
}

/** 调用方持有写事务时复核登记，避免预检到提交之间的竞态。 */
export function registerProject(store: Store, location: ProjectLocation): string {
  if ("id" in location) {
    requireValue(store.one("SELECT id FROM projects WHERE id=?", location.id), "NOT_FOUND", "项目不存在");
    return location.id;
  }
  const existing = store.one<{ id: string; git: string | null }>("SELECT id,git FROM projects WHERE locator=?", location.locator);
  if (existing) {
    requireValue(existing.git === location.git, "PROJECT", "项目主 Git 与既有登记不同，需要显式维护绑定");
    return existing.id;
  }
  const id = newId();
  store.run("INSERT INTO projects VALUES(?,?,?,?)", id, location.locator, location.git, location.root);
  return id;
}
