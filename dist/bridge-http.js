import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { bridgeConfig } from "./bridge-config.js";
import { CollabError, canonical, digest, failure, object, requireValue, uuid } from "./protocol.js";
/** 单个请求的鉴权、限额与路由；不会向客户端暴露 token 或任意命令执行。 */
async function handle(req, res, config, run) {
    try {
        const authorization = req.headers.authorization ?? "";
        const actual = Buffer.from(authorization), expected = Buffer.from(`Bearer ${config.token}`);
        requireValue(actual.length === expected.length && timingSafeEqual(actual, expected), "AUTH", "未授权");
        requireValue(!req.headers.origin, "AUTH", "桥接不接受浏览器来源");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const base = { bridge_id: config.bridge_id, task_id: config.task_id, database_id: config.database_id, generation: config.generation, config_digest: digest(canonical(config)) };
        let input;
        if (req.method === "GET" && url.pathname === "/v1/health")
            input = { ...base, action: "health" };
        else if (req.method === "GET" && url.pathname === "/v1/outbox")
            input = { ...base, action: "outbox", after: Number(url.searchParams.get("after") ?? 0) };
        else {
            requireValue(req.method === "POST" && req.headers["content-type"]?.split(";")[0] === "application/json", "INPUT", "需要JSON POST");
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                const data = Buffer.from(chunk);
                size += data.length;
                requireValue(size <= 3 * 1024 * 1024, "INPUT", "请求超过3 MiB");
                chunks.push(data);
            }
            const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")), "body");
            const requestId = uuid(body.request_id, "request_id");
            const ack = /^\/v1\/outbox\/([^/]+)\/ack$/.exec(url.pathname);
            const reply = /^\/v1\/decisions\/([^/]+)\/reply$/.exec(url.pathname);
            if (url.pathname === "/v1/batches")
                input = { ...base, action: "batches", request_id: requestId, payload: body.payload };
            else if (ack)
                input = { ...base, action: "ack", request_id: requestId, outbox_id: uuid(ack[1], "outbox_id") };
            else if (reply)
                input = { ...base, action: "reply", request_id: requestId, payload: { ...object(body.payload, "payload"), decision_id: uuid(reply[1], "decision_id") } };
            else
                throw new Error("未知桥接路径");
        }
        const result = await run(input);
        res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(result));
    }
    catch (error) {
        if (!res.headersSent && !res.destroyed) {
            const result = failure(error);
            res.writeHead(error instanceof CollabError && error.code === "AUTH" ? 401 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(result));
        }
    }
}
/** 会话持有监听端口；退出/reload 取消在途调用，其他会话通过端口竞争接管。 */
export function registerBridge(pi, invoke) {
    let server;
    let retry;
    let stopped = true;
    let epoch = 0;
    const running = new Set();
    const stop = () => {
        stopped = true;
        epoch++;
        if (retry)
            clearTimeout(retry);
        retry = undefined;
        for (const controller of running)
            controller.abort();
        if (server) {
            server.close();
            server.closeAllConnections();
        }
        server = undefined;
    };
    pi.on("session_start", (_event, ctx) => {
        stop();
        let config;
        try {
            config = bridgeConfig();
        }
        catch (error) {
            ctx.ui.notify(`collab bridge 配置：${error instanceof Error ? error.message : String(error)}`, "error");
            return;
        }
        if (!config)
            return;
        const configured = config;
        stopped = false;
        const sessionEpoch = epoch;
        const listen = () => {
            if (stopped || sessionEpoch !== epoch)
                return;
            const current = createServer((req, res) => {
                if (running.size >= 4) {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                const controller = new AbortController();
                running.add(controller);
                const cancel = () => { if (!res.writableEnded)
                    controller.abort(); };
                res.on("close", cancel);
                void handle(req, res, configured, input => invoke("bridge", input, ctx, controller.signal, 15_000)).finally(() => {
                    running.delete(controller);
                    res.removeListener("close", cancel);
                });
            });
            server = current;
            current.requestTimeout = 10_000;
            current.headersTimeout = 5_000;
            current.timeout = 20_000;
            current.maxRequestsPerSocket = 20;
            current.on("timeout", socket => socket.destroy());
            current.on("error", (error) => {
                if (stopped || sessionEpoch !== epoch)
                    return;
                if (error.code === "EADDRINUSE") {
                    retry = setTimeout(listen, 4000 + Math.floor(Math.random() * 2000));
                    retry.unref();
                }
                else {
                    stopped = true;
                    ctx.ui.notify(`collab bridge 监听失败：${error.code ?? error.message}`, "error");
                }
            });
            current.listen(configured.port, "127.0.0.1");
            current.unref();
        };
        listen();
    });
    pi.on("session_shutdown", stop);
}
