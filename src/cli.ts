#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { failure, requireValue } from "./protocol.ts";

/** 从文件、JSON 参数或标准输入读取单个请求，输入上限防止管道无限增长。 */
async function input(args: string[]): Promise<{ command: string; value: Record<string, unknown> }> {
  const command = args.shift() || "help";
  if (command === "--help" || command === "help") {
    process.stdout.write("collab open|read|show|post|update|resolve|export|snapshot [--input FILE | --json JSON] [--client NAME] [--session-id ID]\ncollab maintain backups|backup|restore|recover [相同输入选项]\n省略 --input/--json 时从标准输入读取 JSON；身份也可由 COLLAB_CLIENT/COLLAB_SESSION_ID 注入。\nCLI open 默认只读；join:true 配合 model、request_id 加入，写入附 membership 凭证。Pi 原生工具自动处理身份。read 缺省未读，也支持 latest/range/matches 与 author/keyword；续页传 next。详细字段见 docs/collab.md。\n");
    return { command: "help", value: {} };
  }
  let action: string | undefined;
  if (command === "maintain") action = args.shift();
  let raw: string | undefined;
  let client = process.env.COLLAB_CLIENT;
  let session = process.env.COLLAB_SESSION_ID;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    requireValue(value !== undefined, "INPUT", `${option} 缺少参数`);
    if (option === "--input") {
      requireValue(raw === undefined, "INPUT", "只能指定一个输入源");
      requireValue(statSync(value).size <= 4 * 1024 * 1024, "INPUT", "输入超过 4 MiB");
      raw = readFileSync(value, "utf8");
    } else if (option === "--json") {
      requireValue(raw === undefined, "INPUT", "只能指定一个输入源");
      raw = value;
    } else if (option === "--client") client = value;
    else if (option === "--session-id") session = value;
    else requireValue(false, "INPUT", `未知选项：${option}`);
  }
  if (raw === undefined) {
    requireValue(!process.stdin.isTTY, "INPUT", "请用 --input、--json 或标准输入提供 JSON 请求");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      requireValue(bytes <= 4 * 1024 * 1024, "INPUT", "输入超过 4 MiB");
      chunks.push(data);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  requireValue(Buffer.byteLength(raw) <= 4 * 1024 * 1024, "INPUT", "输入超过 4 MiB");
  const parsed = JSON.parse(raw);
  requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed), "INPUT", "请求必须为 JSON 对象");
  return { command, value: { ...parsed, ...(client ? { client } : {}), ...(session ? { session_id: session } : {}), ...(action ? { action } : {}) } };
}

/** stdout 只写一个结构化结果；提交后响应中断可用同一 request_id 重试。 */
async function main(): Promise<void> {
  let snapshotRequest: unknown;
  try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    requireValue(major === 22 && minor >= 19 || major >= 24, "RUNTIME", "pi-collab 需要 Node ^22.19.0 || >=24.0.0");
    try { await import("node:sqlite"); }
    catch (error) { requireValue(false, "RUNTIME", `当前 Node 未提供 node:sqlite：${error instanceof Error ? error.message : error}`); }
    const { execute, requestFrom } = await import("./service.ts");
    const parsed = await input(process.argv.slice(2));
    if (parsed.command === "help") return;
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    if (parsed.command === "snapshot") {
      snapshotRequest = parsed.value.request_id;
      process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    }
    try {
      const result = await execute(requestFrom(parsed.value, parsed.command), controller.signal);
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally {
      process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ...failure(error), ...(snapshotRequest ? { request_id: snapshotRequest } : {}) }) + "\n");
    process.exitCode = 1;
  }
}

await main();
