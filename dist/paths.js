import { lstatSync, realpathSync, statSync, statfsSync } from "node:fs";
import { release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { requireValue, text } from "./protocol.js";
/** 只在真正的 WSL 宿主上启用 Windows Git 路径转换。 */
export const isWsl = process.platform === "linux" && /microsoft/i.test(release());
/** WSL 默认挂载的 Windows 盘；native Windows 不经过 wslpath。 */
export function isWindowsMount(path) { return isWsl && /^\/mnt\/[a-z](?:\/|$)/i.test(path); }
/** 同一宿主上的保守比较键；大小写敏感卷可能多报冲突，不进行写探测。 */
export function pathKey(path) {
    const normalized = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
    const unicode = process.platform === "darwin" ? normalized.normalize("NFC") : normalized;
    return process.platform === "win32" || process.platform === "darwin" || isWindowsMount(path) ? unicode.toLowerCase() : unicode;
}
/** 跨盘 relative 仍是绝对路径，必须与 .. 一样视为越界。 */
export function within(root, target) {
    const part = relative(root, target);
    return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
/** 解析已存在的父目录和 junction；新文件尾部保留字面形式，拒绝逃逸及硬链接。 */
export function scopePaths(root, input) {
    requireValue(Array.isArray(input) && input.length > 0 && input.length <= 64, "INPUT", "scope 必须是 1..64 项字面路径");
    requireValue(Buffer.byteLength(JSON.stringify(input)) <= 8192, "INPUT", "scope 总计最多 8 KiB");
    return input.map(value => {
        const path = text(value, "scope", 1024);
        const parts = path.split("/");
        requireValue(!isAbsolute(path) && !/[\\:*?\[\]{}\r\n]/.test(path) && (path === "." || parts.every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")), "SCOPE", "scope 只接受根相对字面文件/目录");
        if (process.platform === "win32" || isWindowsMount(root))
            requireValue(path === "." || parts.every(part => !/[. ]$/.test(part)), "SCOPE", "Windows 范围不能含尾随空格或句点别名");
        let existing = resolve(root, path);
        const tail = [];
        while (!lstatSync(existing, { throwIfNoEntry: false })) {
            const parent = dirname(existing);
            requireValue(parent !== existing, "SCOPE", "范围父路径不存在");
            tail.unshift(basename(existing));
            existing = parent;
        }
        const stat = statSync(existing);
        requireValue(!stat.isFile() || !tail.length, "SCOPE", "文件不能作为新范围的父目录");
        requireValue(!stat.isFile() || stat.nlink === 1, "SCOPE", "硬链接文件请先消除别名，再登记范围");
        const target = join(realpathSync(existing), ...tail);
        requireValue(within(root, target), "SCOPE", "符号链接范围不能逃出工作区");
        requireValue(!relative(root, target).split(sep).some(part => part.toLowerCase().replace(/[. ]+$/, "") === ".git"), "SCOPE", "范围不能指向 Git 管理目录");
        return { path, key: pathKey(target) };
    });
}
/** 绝对范围相同或有父子包含即冲突；根目录末尾的分隔符不重复追加。 */
export function overlaps(a, b) {
    return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`) || b.startsWith(a.endsWith("/") ? a : `${a}/`);
}
/** 已知共享位置拒绝；不能识别文件系统时返回告警，不伪称验证过安全性。 */
export function databaseFilesystem(directory) {
    const path = realpathSync(directory);
    requireValue(!/^(?:\\\\|\/\/)/.test(path) || /^\\\\\?\\[a-z]:\\/i.test(path), "FILESYSTEM", "collab 数据库不能位于 UNC/WSL 共享路径");
    requireValue(!isWindowsMount(path), "FILESYSTEM", "WSL 数据库请放在 Linux 本地文件系统，不能与 Windows 直接共用数据库文件");
    if (process.platform !== "linux")
        return ["当前平台仅核对了可识别的共享路径；请确认数据库目录位于本机且不受网络映射或同步软件管理"];
    let type;
    try {
        type = Number(statfsSync(path).type) >>> 0;
    }
    catch (error) {
        return [`无法识别数据库文件系统：${error instanceof Error ? error.message : error}；请确认目录在本机，且非共享或同步盘`];
    }
    // Linux 的 NFS/CIFS/SMB/CODA/AFS/9P；识别不到的 FUSE 等交给显式告警和使用约束。
    requireValue(![0x6969, 0xff534d42, 0x517b, 0x73757245, 0x5346414f, 0x01021997].includes(type), "FILESYSTEM", "collab 数据库不能位于网络或跨内核共享文件系统");
    const knownLocal = [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1, 0x4d44, 0x5346544e];
    return knownLocal.includes(type) ? [] : [`文件系统类型 0x${type.toString(16)} 未被识别为本地类型；请确认数据库目录非共享或同步盘`];
}
