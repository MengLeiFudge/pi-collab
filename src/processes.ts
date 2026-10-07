import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { CollabError, requireValue } from "./protocol.ts";

/** Linux 的启动标识能排除 PID 复用；其他平台保守使用存活检查。 */
export function processIdentity(pid: number): string | null {
  if (process.platform !== "linux") return `${process.platform}:${pid}`;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    requireValue(start && /^\d+$/.test(start), "MAINTENANCE", "无法读取维护进程的启动标识");
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
  } catch (error) {
    if (pid === process.pid) return `${process.platform}:${pid}`;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 只有明确不存在才能接管；EPERM、未知和其他平台的 PID 复用都视为仍可能在运行。 */
export function processGone(pid: number, identity: string): boolean {
  if (process.platform === "linux") {
    try {
      const current = processIdentity(pid);
      if (current !== null) return current !== identity && /^[0-9a-f-]{36}:\d+$/i.test(identity) && /^[0-9a-f-]{36}:\d+$/i.test(current);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Bun/单文件 Pi 不以自身路径冒充 Node；显式覆盖必须是绝对路径。 */
export function nodeExecutable(): string {
  if (process.env.COLLAB_NODE) {
    requireValue(isAbsolute(process.env.COLLAB_NODE), "RUNTIME", "COLLAB_NODE 必须是 Node 可执行文件的绝对路径");
    return process.env.COLLAB_NODE;
  }
  requireValue(!process.versions.bun && /^node(?:\.exe)?$/i.test(basename(process.execPath)), "RUNTIME", "此 Pi 启动方式需要用 COLLAB_NODE 指定 Node ^22.19.0 || >=24.0.0 的绝对路径");
  return process.execPath;
}

/** 外部命令的期限、取消及字节预算由其调用方明确指定。 */
export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeout: number; maxBytes: number;
}

/** 返回非零码让 Git 调用方判断预期状态；启动失败、取消和超时始终抛错。 */
export interface ProcessResult { stdout: string; stderr: string; code: number | null }

/** 只管理本实例亲自启动且仍存活的子进程，不根据持久化 PID 终止进程。 */
export class ProcessRunner {
  private readonly stops = new Map<ChildProcess, (reason: string) => void>();

  /** 停止当前实例的在途调用；保留不确定写入的原请求，不能推断未提交。 */
  stop(): void { for (const stop of this.stops.values()) stop("宿主正在关闭；写入结果须沿原请求核对"); }

  /** POSIX 使用独立进程组；Windows taskkill 只针对仍由此 ChildProcess 持有的 PID。 */
  run(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    return new Promise((accept, reject) => {
      if (options.signal?.aborted) { reject(new CollabError("CANCELLED", "命令已取消")); return; }
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", bytes = 0;
      let stopped: CollabError | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const live = (): boolean => !!child.pid && child.exitCode === null && child.signalCode === null;
      const finish = (code: number | null): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (deadline) clearTimeout(deadline);
        options.signal?.removeEventListener("abort", cancel);
        this.stops.delete(child);
        if (stopped) reject(stopped); else accept({ stdout, stderr, code });
      };
      const groupSignal = (signal: NodeJS.Signals): void => {
        if (!live()) return;
        try { process.kill(-child.pid!, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && stopped) stopped.info = { ...stopped.info, termination_error: String(error) }; }
      };
      const stop = (reason: string, code = "CANCELLED"): void => {
        if (stopped || finished) return;
        stopped = new CollabError(code, reason, { command, pid: child.pid, outcome: "unknown" });
        if (process.platform === "win32") {
          if (live()) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeout: 3000, windowsHide: true }, error => {
            if (error && stopped) stopped.info = { ...stopped.info, termination_error: error.message };
          });
        } else {
          groupSignal("SIGTERM");
          grace = setTimeout(() => groupSignal("SIGKILL"), 2000);
        }
        // 子孙可能仍持有管道；期限到后报告未知结果，不无限等待 close。
        deadline = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null);
        }, 4000);
      };
      const cancel = (): void => stop("命令已取消；写入可能已提交，请沿原 request_id 核对");
      const timer = setTimeout(() => stop("命令超过执行期限；写入结果和维护门禁须核对", "TIMEOUT"), options.timeout);
      this.stops.set(child, stop);
      options.signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stopped) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > options.maxBytes) { stop("命令输出超过字节预算", "OUTPUT_LIMIT"); return; }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
      child.stdin.on("error", error => { if (!finished) stop(error.message, "PROCESS"); });
      child.on("error", error => { stopped ??= new CollabError("PROCESS", error.message, { command }); finish(null); });
      child.on("close", finish);
      child.stdin.end(options.input);
      if (options.signal?.aborted) cancel();
    });
  }
}
