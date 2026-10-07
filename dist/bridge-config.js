import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "./signals.js";
import { integer, object, requireValue, text, uuid } from "./protocol.js";
/** 缺少配置表示未部署；无效配置报错，不静默关闭鉴权。 */
export function bridgeConfig() {
    let raw;
    try {
        raw = readFileSync(process.env.COLLAB_BRIDGE_CONFIG || join(dataDirectory(), "bridge.json"), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const value = object(JSON.parse(raw), "bridge config");
    const token = text(value.token, "token", 256);
    requireValue(/^[a-zA-Z0-9_-]{32,256}$/.test(token), "CONFIG", "token 必须为至少32位随机 base64url 字符串");
    const port = integer(value.port, "port", 19191, 65535);
    requireValue(port > 1023, "CONFIG", "port 必须大于1023");
    const max = integer(value.max_raw_bytes, "max_raw_bytes", 16 * 1024 * 1024, 256 * 1024 * 1024);
    requireValue(max >= 65536, "CONFIG", "原文总量上限至少64 KiB");
    const bot = text(value.bot_id ?? "1443944862", "bot_id", 64);
    requireValue(/^\d+$/.test(bot), "CONFIG", "bot_id 需要QQ号");
    return {
        bridge_id: uuid(value.bridge_id, "bridge_id"), database_id: uuid(value.database_id, "database_id"),
        generation: uuid(value.generation, "generation"), task_id: uuid(value.task_id, "task_id"),
        platform_id: text(value.platform_id, "platform_id", 128), bot_id: bot, owner_id: "605738729",
        token, port, max_raw_bytes: max,
    };
}
