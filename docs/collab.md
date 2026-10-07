# Collab 操作说明

## 房间与身份

工具 `collab` 用 `command` 选择命令、`input` 传业务字段。Pi 自动传当前完整模型名称、会话 ID、成员 lease 和阅读位置；不要伪造身份。实施成员仅来自用户独立启动的同机 Pi 会话，不自动创建 AI 进程。配置 QQ 桥接后，可出现 external 类型成员，其需求摘要不扩大授权，也没有 Pi model/lease 或实施权限；配置与 read/update bridge 入口见 [桥接说明](bridge.md)。

`open {create:true,title,body}` 直接创建数据库房间并加入，项目默认为 Pi 当前目录。`open {task_id}` 加入既有房间。`open {action:"rooms",topic}` 查本项目主题，结果中的 decision 指示唯一匹配或需选择；相近名称不是自动加入依据。`open {action:"invite"}` 生成可粘贴的邀请，可带用户已指定的 invite_duty、invite_scope；invite_scope 接受文本或 1–64 项非空字符串数组，数组以“、”连接，结果限 2048 UTF-8 字节。`/collab` 是用户菜单，保留显式 join/rejoin/info/copy/scopes 命令。

房间与合同直接保存在数据库中。导出是审阅副本，当前合同仍通过 open/show 读取。

成员按 Pi 模型完整名称匹配，新会话接替同名成员。SUPERSEDED 后旧会话只读且停止自动接收，不能自动 rejoin。加入从当前上界订阅；概况提供最近十条摘要、成员职责和上次查询位置，历史按需读取。名单不保证实时在线。

## 阅读、讨论与状态

- `read` 默认未读正文；无消息返回“没有新的消息”。`latest:N`、`range:{from,to}`、`matches:{from,to}` 三种位置互斥；author 模型全名或 `{member_id}` 与 keyword 可组合。单页最多十条，返回 next 时原样续页。
- `show {object_id}` 展开消息、版本、快照、范围登记；文档支持 compare_to。正文按 offset/limit 分页，next_offset 非空时继续。
- `post {body,summary?,kind?}`，kind 为 message 或 issue。reply_to 为同房间 `{kind:"message"|"revision",id}`。仅阶段完成、发现缺陷或需要决定时发帖，默认 1–3 行：结论、产物引用、下一步；细节放合同或产物，不发收讫、不复述。
- `post {priority:"urgent",reason,...}` 要说明使当前工作无效或需停用结论的具体原因；notify 为 all 或模型名数组，通知对象与优先级独立。用户可关闭忙碌紧急通知。普通消息空闲合并，紧急正文在工具批次边界送达；不取消正在运行的工具。
- 文档 `update {base_revision,body,...}` 整份替换并保存历史版本；可用 restore_revision 恢复历史内容。版本冲突先读再合并，不盲重试。
- 推进状态 `update {progress:{stage,owner,next_action,blocked,resume,status},base_progress,contract_revision}` 使用独立锁，首次 base_progress 为 null。blocked 接受原因文本、布尔值或省略：false/省略存为空串，true 存为“有阻塞（未说明原因）”；其余字段按原类型提供，status 独立指定。当前状态以 progress 为准，历史文档中的状态仅是当时记录。状态、职责和范围变更不单独唤醒，交接另发一条 post。
- `resolve {issue_id,base_revision,state,resolution_id}`，state 为 open/addressed/rejected；解释消息必须同房间且不是意见自身。`read {view:"index"}` 查看未解决意见和事件摘要。
- `export {output?}` 导出带数据库/世代/对象 UUID 的 Markdown；output 必须是新文件，不能覆盖运行数据或已有文件。无 output 时分页返回内容。

默认接收与自由查询共享实际交付位置，Pi 将 details 保存到会话分支，/tree 与压缩不要求模型记游标。查询仅排除实际返回的消息，不跳过中间未读。没有内容就结束回合，不轮询或发收讫；授权且下一项属于自己时继续。

## 成员职责与写入范围

初次加入带 `duty:{text,source}`；同名接替继承职责。修改用 `update {duty:{text,source,base_duty,member_id?}}`，版本取概况，首次为 null。职责必须来自用户指示，板上建议不扩大权限。

登记示例：`update {assignment:{action:"register",stage,deliverable,contract_revision,basis,scope:["src/ui"],reason}}`。workspace 默认当前工作目录，必须定位到房间所属项目。普通目录项目使用建房时的目录作 workspace，子目录写进 scope；归属不匹配时错误返回 project_root 和修正方式，不会自动改绑项目。scope 是 1–64 个根相对字面路径，统一 `/` 分隔，不支持 glob、..、.git 或越界链接。登记跨房间按实际绝对范围查重，active 和 release-pending 均占用；冲突附占用者、房间和修订。登记不是文件系统锁。

`read {view:"assignments",all_rooms?,include_released?}` 分页查看；show 登记 ID 取当前，修订 ID 取历史。后续 update assignment 带 `targets:[{id,base_assignment}]`、reason：

- update 改阶段、交付物、basis、blocked，带当前 contract_revision，不改范围。
- resume 接替旧登记，必须 writes_stopped:true、contract_revision，重新检查路径和冲突。
- complete 完成交付；writes_stopped:true 释放，否则 release-pending。
- release 释放本人登记，必须确认停写。
- user-release 仅按用户明确指示，user_authorized:true，允许处理他人/废弃房间登记；解除不代表停止旧进程。

离开、空闲、任务 completed、同名接替都不能证明在途 shell 已停。完成任务把仍 active 的登记转为 release-pending。先确定共享接口、配置、锁文件和生成物负责人，再按不相交文件范围并行。

## 快照

`snapshot {scope:["src"],worktree?}` 使用项目登记的主 Git，Pi 默认当前目录。临时 index 包含范围内跟踪与未跟踪文件，遵守 ignore，不改真实 index、HEAD、分支。快照以独立 ref 固定，返回全局 UUID；只有工作区最终内容，不区分真实暂存状态。子模块、嵌套仓库和稀疏工作区不当作完整文件快照。

`mode:"register"` 可登记已经固定的外部对象，需提供 ref、commit、base、scope、worktree 等采集描述。出错后用原 request_id 核对；SNAPSHOT_PENDING 不重新采样。快照证明路径内容，不证明作者归属。

## CLI、请求去重和维护

编译后的 `pi-collab <命令> --input 请求.json` 或 `node dist/cli.js <命令> --input 请求.json` 接收 JSON，也支持 --json 和 stdin。身份必须是当前 Pi 的 client=pi、session_id；CLI open 默认只读，join:true 需 model 和 request_id，后续写入附 membership。正常 Pi 工具无需用户操作 CLI。

Pi 在可能提交前固定 request_id，成功和失败都返回它。超时/取消可能已提交，重试原 ID；冲突时核对原结果，不生成新 ID 自动重发。业务指纹包含成员身份及业务字段，不包含阅读位置等传输字段。

无 task_id 的新建请求先以 open create:true、prepare_creation:true 取得 database_id 和 generation，再沿同一 request_id 提交。准备步骤不创建房间；Pi 自动执行。建房失败重试必须带原 request_id、database_id、generation，不能重新选世代。实际创建、项目登记、首版、加入和创建去重在一个事务内；旧加入请求不能夺回失效身份。

维护命令为 `pi-collab maintain backups|backup|restore|recover --input 请求.json`。数据库使用 schema 2，连接与普通恢复源都必须匹配该版本。公开 schema 1 通过 maintain migrate 显式备份升级，迁移前备份的离线回退步骤见 [桥接说明](bridge.md)。维护会影响共享库，应先协调在途操作。恢复前先备份当前库，并保护选中的恢复源；恢复前备份失败阻止操作，例行备份失败告警。轮换保留七个普通备份及当前受保护的恢复源。恢复可读库使用 SQLite backup API 写回，不替换正在使用的主数据库文件；损坏库不自动抢救替换。备份中的维护标记由正规恢复入口处理，不把备份直接当业务库打开。

recover 只有确认原维护进程已不存在时接管；未知、权限拒绝、PID 可能复用都不擅自解锁。恢复更换 generation，外部引用须保留 UUID 和世代。旧请求、游标及缓存不能自动改绑新世代。
