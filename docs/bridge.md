# QQ 桥接

桥接只传需求和决定，不启动 Pi 或执行电脑操作。HTTP 服务由已启动的 Pi 会话持有，监听 127.0.0.1；没有 Pi 会话时插件只保留待发原文。外部成员没有 Pi 模型身份或接替凭证。

## 部署与 schema 2

先完成版本安装，再协调所有写入停止、释放 active/release-pending assignment。使用新版本 CLI 显式升级已有公开 schema 1 数据库：

```sh
node dist/cli.js maintain migrate --json '{}'
```

迁移先取得 SQLite 写锁，确认没有维护和未释放范围，再设置所有业务入口遵守的维护门禁。备份保存到 collab 数据目录的 migration-backups/schema-1-<UUID>.sqlite3；备份中的维护标记会清除。备份失败不升级，DDL、协议触发器和 user_version 在同一事务中提交。迁移保留数据库身份、世代、历史和成员；旧客户端在升级后被 schema/协议检查拒绝写入，所有参与会话应升级并重新加载。全新数据库直接使用 schema 2。普通打开不隐式迁移。

迁移前备份为可独立打开的 schema 1 文件，不由 schema 2 的普通 restore 接受。如需完整回退：停止全部 Pi、CLI 和桥接进程，保留整个当前 collab 数据目录作为归档，在原路径建立空目录，仅复制所选迁移备份并命名 collab.sqlite3，再使用 v0.1.2。不要将旧 WAL/SHM 复制到新目录。迁移后产生的数据仍在归档中，但不在回退库内；这是显式的全库回退，不做跨 schema 合并。迁移进程若在设置门禁后中断且尚未升级，用 v0.1.2 的 maintain recover 核实旧 PID 已退出后解锁，再重试迁移。迁移备份不参与普通七份备份轮换。

## 本地绑定

在 Pi 的 collab 数据目录放置私密 bridge.json（可用 COLLAB_BRIDGE_CONFIG 指向另一个绝对配置文件）。以下仅为字段示意，UUID 必须换成实际值，token 使用至少 32 位随机 base64url 字符串：

```json
{
  "bridge_id": "<新生成的UUID>",
  "database_id": "<collab数据库UUID>",
  "generation": "<当前世代UUID>",
  "task_id": "<接收需求的房间UUID>",
  "platform_id": "<AstrBot平台实例ID>",
  "bot_id": "1443944862",
  "token": "<随机密钥>",
  "port": 19191,
  "max_raw_bytes": 16777216
}
```

房间必须已存在；房间成员通过 open 的返回值取得 database_id/generation/task_id。配置不随聊天或请求改绑。文件和备份只给本机用户读取，不提交 Git、不把 token 贴到板上或提供给模型。配置完成后重新加载所有 Pi 扩展，使凭证与绑定一致；变更配置时旧持有者的请求会失败关闭。配置缺失时不监听。恢复改变 generation 后需要重新核对房间并配置，不自动重发旧世代批次。

在 AstrBot 新插件配置中填写相同绑定、token、port，并指定实际 provider_id；插件通过 llm_generate(tools=None) 单次汇总。默认示例 provider_id 为现有 deepseek-responses/deepseek-flash，必须核对它实际对应所需模型。插件未配置时明确记录未配置，不收件、不调用模型。运行数据在 AstrBot 原生 plugin_data/astrbot_plugin_collab_bridge，源码目录不保存运行数据。Windows 访问 WSL localhost 取决于本机网络配置，安装步骤不包含连通性探针。

MaiBot 对等插件位于 plugins/qqbot_collab_bridge，plugin.enabled 默认 false。当前仅 AstrBot 运行启用。未来切换账号须明确授权，并同时修改 Pi 的 bot_id/platform_id 与新插件绑定、停用旧入口；MaiBot 的默认 bot_id 是夜凛、平台为 qq。两者使用同一 HTTP 协议，队列和框架生命周期各自实现。更换绑定前归档旧队列，不能把旧群需求自动送到新房间。

## 群收件与回传

所有群只收直接 @机器人 的当前正文文本，无需“需求”前缀；不采集整段群聊，不展开图片、引用或转发内容，没有正文的 @ 不入队，机器人自身消息排除。群收集旁路进行，不调用模型、不回复、不终止原事件，原有聊天和自然语言指令照常处理；入队失败只记日志。私聊不作为汇总素材，主人确认仍单独解析。每群默认到 10 条或首条等待 30 分钟时冻结一批，单批最多 50 条、每条最多 8192 UTF-8 字节。服务鉴权和绑定核对成功后才汇总，UTC 日全机器人默认最多 24 次模型尝试，失败也计数。

冻结的 batch_id、原文与预算先落盘，成功摘要在 HTTP 前落盘；HTTP 重试复用原 ID 和完整包。模型失败或中断已占用预算，至少等待 30 分钟才重试该批；已生成摘要不重调模型。汇总提炼项目/Pi需求、问题和分歧并保留来源 ID，忽略闲聊、问候和画图、查询等日常指令；固定空结果 NO_REQUIREMENTS 在本地持久化为已处理，不提交到 Pi、不发帖、不唤醒，仍计尝试预算，原文按七天规则清理。非空摘要由服务在单个事务中写入批次、来源与一条普通消息，原文不进入自动投递。模型筛选可能漏判或误判，摘要明确标记为未获主人执行批准的素材。

原文按最初收件时间保留最多七天，两端在运行时清理；停机期间不启动定时服务，恢复运行时先清理再处理。已确认入库的本地原文可提前释放。容量默认 16 MiB，插件还限制 10000 条原文；满时拒收并记日志。摘要、决定和来源审计长期保留。原文过期属于数据库逻辑删除，不承诺清除磁盘残页、框架聊天历史或用户另存的备份。到期后原文查询返回 null，摘要仍可读。

插件首次成功处理与从暂停恢复时记一条 info，暂停时记 warning 和错误类型；同一持续故障不刷屏，不记录 token、请求体或模型内容。桥接不新增逐条模型调用，原有聊天与生图等功能仍按各自流程运行。

结论必须由 Pi 显式选择，来源群从批次查出，不接受任意群目标。主人待决卡片只私聊 QQ 605738729；确认格式为“确认 <决策ID> <选项>”。决定固定合同版本、题面哈希、选项、接收成员和有效期；过期、取消、替换或合同变化后拒绝确认。插件元数据是信任边界：token 持有者可代表该插件，服务不能独立证明 QQ 平台身份；模型不接触 token 或控制接口。

## Pi 本地操作

操作仍用 collab 的 read/update 与嵌套 bridge 字段，Pi 正常注入成员凭证及请求 ID。下列 input 均附目标 task_id：

- 查询原文：read，bridge 为 `{ "action":"inbox", "batch_id":"<UUID>" }`。
- 创建决定：update，bridge 为 `{ "action":"create-decision", "batch_id":"<UUID>", "contract_revision":"<当前合同UUID>", "question":"完整待选方案", "options":{"1":"同意","2":"拒绝"} }`。默认有效期 24 小时，可用 expires_at 指定未来七天内的 Unix 毫秒时间。修改题面时传 replaces 指向旧待决 UUID，旧项在同事务内取消。
- 查询审计：read，bridge 为 `{ "action":"decision", "decision_id":"<UUID>" }`。
- 撤销决定：update，bridge 为 `{ "action":"cancel-decision", "decision_id":"<UUID>" }`。
- 回传结论：update，bridge 为 `{ "action":"conclusion", "batch_id":"<UUID>", "body":"一句最终结论" }`。最多 512 UTF-8 字节，不含换行或反引号；调用者负责不提供代码、路径或 diff。

主人决定是来源明确的授权证据，执行者仍须核对自己的会话授权和范围。桥接不会把自动摘要升级成主人决定。

## HTTP 合同（协议 1）

每个请求都带 Authorization: Bearer token，拒绝浏览器 Origin，不开放 CORS；只允许固定路径，POST 必须 application/json。请求最多 3 MiB；最多四个在途 CLI 请求，单次 15 秒，输入和输出均有上限。

| 请求 | 内容 |
| --- | --- |
| GET /v1/health | 返回 protocol、bridge_id、database_id、generation、task_id、platform_id、bot_id；需逐项匹配 |
| POST /v1/batches | request_id 与 payload；payload 含 batch_id、platform_id、bot_id、group_id、summary、items，每项为 message_id/sender_id/received_at/body |
| GET /v1/outbox?after=0 | 返回尚未 ack 的最多20项；不开放完整房间阅读；插件每轮从0读取，防止失败项被游标跳过 |
| POST /v1/outbox/{id}/ack | request_id；只确认同一绑定/世代的条目 |
| POST /v1/decisions/{id}/reply | request_id 与 payload；payload 为 option、event，event 包含平台/机器人/主人发送者、private类型、空group_id、message_id、确认原文body |

写入幂等 ID 固定，重用 ID 提交不同内容拒绝；传输配置摘要不参与业务指纹，允许原绑定内轮换密钥。QQ 发送后先记本地 sent，再 ack 服务；在 QQ 发送成功和本地落盘之间崩溃仍可能重复，输出附稳定协作 ID，不声称严格恰好一次。

只对 EADDRINUSE 退避竞争端口；其他监听错误直接提示。session_shutdown/reload 取消本会话在途子进程并关闭连接；未收到成功响应的写入结果不确定，插件沿原 request_id 重试。
