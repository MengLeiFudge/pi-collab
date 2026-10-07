import { ProcessRunner } from "./processes.js";
import { isWsl, isWindowsMount, pathKey, within } from "./paths.js";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { canonical, CollabError, requireValue, text } from "./protocol.js";
import { convertPath } from "./routing.js";
/** 对象 ID 兼容 Git SHA-1 与 SHA-256；不接受表达式或缩写。 */
export function objectId(value, name) {
    const id = text(value, name, 64);
    requireValue(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id), "INPUT", `${name} 必须为完整 Git 对象 ID`);
    return id;
}
/** 范围是仓库根相对的字面路径；避免 pathspec 魔法或上层路径扩大范围。 */
export function snapshotScope(value) {
    requireValue(Array.isArray(value) && value.length > 0 && value.length <= 64, "INPUT", "scope 需要 1..64 个仓库根相对字面路径");
    const paths = value.map(item => {
        const path = text(item, "scope", 1024);
        requireValue(path === "." || !isAbsolute(path) && !/[\\:\r\n]/.test(path) && path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"), "SCOPE", "scope 只接受根相对字面路径或 .，不能含 .git、空段、冒号、反斜杠或 ..");
        return path;
    });
    requireValue(Buffer.byteLength(JSON.stringify(paths)) <= 8192, "SCOPE", "scope 总长度超过 8 KiB");
    return [...new Set(paths)].sort();
}
/** Git 启动进程有共享期限和输出上限；Windows interop 退出不证明其后代全部退出，接续仍须核对 ref。 */
export class SnapshotGit {
    git;
    windows;
    runner = new ProcessRunner();
    interop;
    deadline = Date.now() + 60_000;
    signal;
    cwd;
    constructor(project, worktree, signal) {
        requireValue(project.git && project.locator.startsWith("git:"), "GIT_PROJECT", "当前任务不是已登记主 Git 的仓库项目，不能创建审阅快照");
        this.git = project.git;
        this.interop = isWsl && /\.exe$/i.test(project.git);
        this.windows = process.platform === "win32" || this.interop;
        this.cwd = realpathSync(worktree);
        requireValue(!isWindowsMount(this.cwd) || this.interop, "GIT", "Windows 盘仓库必须使用登记的主 git.exe");
        this.signal = signal;
    }
    /** Windows Git 接收 Windows 路径，WSL 自身的文件操作保留 Linux 路径。 */
    native(path) { return this.interop ? convertPath(path, "-w") : path; }
    /** Git 返回绝对路径后转回文件系统定位，不用输出的显示形式比较项目。 */
    local(path) { return realpathSync(this.interop && win32.isAbsolute(path) && !path.startsWith("/") ? convertPath(path, "-u") : path); }
    /** 只允许列出的预期非零码；其他失败保留 stderr，绝不当成空结果。 */
    async run(args, index, allowed = []) {
        requireValue(!this.signal?.aborted, "CANCELLED", "快照操作已取消");
        const timeout = Math.min(20_000, this.deadline - Date.now());
        requireValue(timeout > 0, "TIMEOUT", "Git 快照超过 60 秒期限");
        const env = { ...process.env };
        for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"])
            delete env[key];
        env.GIT_TERMINAL_PROMPT = "0";
        env.GIT_OPTIONAL_LOCKS = "0";
        if (index)
            env.GIT_INDEX_FILE = this.native(index);
        if (this.interop) {
            const controlled = new Set(["GIT_INDEX_FILE", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"]);
            env.WSLENV = [...(env.WSLENV ?? "").split(":").filter(item => item && !controlled.has(item.split("/")[0])), ...[...controlled].map(key => `${key}/w`)].join(":");
        }
        const result = await this.runner.run(this.git, ["--no-replace-objects", "--literal-pathspecs", "-C", this.native(this.cwd), ...args], { env, timeout, maxBytes: 8 * 1024 * 1024, signal: this.signal });
        requireValue(result.code === 0 || result.code !== null && allowed.includes(result.code), "GIT", result.stderr.trim() || `Git exit ${result.code}`, { git: this.git, operation: args[0] });
        return result.stdout;
    }
    /** 每次创建或接续均核对主 Git、工作树和项目 common dir。 */
    async locate(project) {
        const common = this.local((await this.run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
        requireValue(`git:${pathKey(common)}` === project.locator, "PROJECT", "所选 worktree 不属于当前任务的 Git 项目");
        this.cwd = this.local((await this.run(["rev-parse", "--show-toplevel"])).trim());
        return { worktree: this.cwd, common };
    }
    /** Git 的范围匹配仍由字面 pathspec 完成；前缀用于核对范围外没有改变。 */
    covers(scope, path) {
        const fold = (value) => process.platform === "darwin" ? value.normalize("NFC").toLowerCase() : this.windows ? value.toLowerCase() : value;
        const normalized = fold(path);
        return scope.some(item => { const prefix = fold(item); return prefix === "." || normalized === prefix || normalized.startsWith(prefix + "/"); });
    }
    /** 暂不展开子模块/嵌套仓库；明确拒绝范围内的 gitlink，防止误称已保存其内容。 */
    async rejectGitlinks(tree, scope) {
        const entries = (await this.run(["ls-tree", "-r", "-z", tree])).split("\0");
        for (const entry of entries) {
            if (!entry.startsWith("160000 "))
                continue;
            const path = entry.slice(entry.indexOf("\t") + 1);
            requireValue(!this.covers(scope, path) && !scope.some(item => this.covers([path], item)), "SUBMODULE", "scope 涉及子模块或嵌套 Git 工作区，不能当作普通文件快照", { path });
        }
    }
    /** 临时 index 放在 common dir，Windows Git 可原生访问；真实 index 从不打开写入。 */
    async capture(plan) {
        requireValue((await this.run(["config", "--bool", "--get", "core.sparseCheckout"], undefined, [1])).trim() !== "true", "SPARSE_CHECKOUT", "稀疏工作区不能直接采集完整范围，请使用完整 worktree 或登记已固定对象");
        await this.rejectGitlinks(plan.base, plan.scope);
        for (const path of plan.scope) {
            if (path === ".")
                continue;
            let parent = dirname(resolve(plan.worktree, path));
            for (;;) {
                try {
                    lstatSync(parent);
                    break;
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                    const next = dirname(parent);
                    requireValue(next !== parent, "SCOPE", "范围父路径不存在");
                    parent = next;
                }
            }
            requireValue(within(plan.worktree, realpathSync(parent)), "SCOPE", "scope 的父目录经符号链接越出仓库");
        }
        const temporary = mkdtempSync(join(plan.common_dir, "collab-index-"));
        const index = join(temporary, "index");
        let failure;
        try {
            await this.run(["read-tree", plan.base], index);
            await this.run(["add", "-A", "--", ...plan.scope], index);
            const tree = objectId((await this.run(["write-tree"], index)).trim(), "tree");
            await this.rejectGitlinks(tree, plan.scope);
            const commit = objectId((await this.run(["-c", "user.name=Collab Snapshot", "-c", "user.email=collab@localhost", "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", plan.base, "-m", `collab-snapshot:v1\n${canonical(plan)}`], index)).trim(), "commit");
            await this.run(["update-ref", plan.ref, commit, "0".repeat(commit.length)], index);
            return { commit, tree };
        }
        catch (error) {
            failure = error;
            throw error;
        }
        finally {
            try {
                if (failure instanceof CollabError && failure.info?.outcome === "unknown")
                    failure.info = { ...failure.info, temporary, cleanup_deferred: true };
                else
                    rmSync(temporary, { recursive: true, force: true });
            }
            catch (error) {
                const detail = { temporary, cleanup_error: String(error) };
                if (failure instanceof CollabError)
                    failure.info = { ...failure.info, ...detail };
                else
                    throw new CollabError("CLEANUP", "临时 index 清理失败；固定对象与原请求需核对", { ...detail, ...(failure ? { original_error: String(failure) } : {}) });
            }
        }
    }
    /** 重试只核对已固定 ref；没有 ref 时不重新采样工作区。 */
    async verify(plan) {
        const commit = (await this.run(["rev-parse", "--verify", "--quiet", plan.ref], undefined, [1])).trim();
        requireValue(commit, "SNAPSHOT_PENDING", "快照意图已保留，但没有可核对的固定 ref；原操作可能仍在执行或已中断。不要用原请求重新采样", { snapshot_id: plan.id, ref: plan.ref });
        objectId(commit, "commit");
        requireValue((await this.run(["cat-file", "-t", commit])).trim() === "commit", "SNAPSHOT_REF", "ref 必须直接指向 commit，不能使用 tag 或其他对象");
        requireValue(!plan.expected_commit || commit === plan.expected_commit, "SNAPSHOT_CHANGED", "固定 ref 与声明 commit 不一致");
        const raw = await this.run(["cat-file", "commit", commit]);
        const split = raw.indexOf("\n\n");
        const headers = raw.slice(0, split).split("\n");
        requireValue(headers.filter(line => line.startsWith("parent ")).join("\n") === `parent ${plan.base}`, "SNAPSHOT_BASE", "快照必须只有一个父提交，且等于固定 base");
        const tree = objectId(headers.find(line => line.startsWith("tree "))?.slice(5), "tree");
        if (plan.source === "worktree")
            requireValue(raw.slice(split + 2).trimEnd() === `collab-snapshot:v1\n${canonical(plan)}`, "SNAPSHOT_CHANGED", "固定对象的采集描述与原请求不一致");
        const paths = (await this.run(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", plan.base, commit])).split("\0").filter(Boolean);
        requireValue(paths.every(path => this.covers(plan.scope, path)), "SCOPE", "快照包含 scope 之外的变化");
        await this.rejectGitlinks(plan.base, plan.scope);
        await this.rejectGitlinks(tree, plan.scope);
        return { commit, tree };
    }
}
