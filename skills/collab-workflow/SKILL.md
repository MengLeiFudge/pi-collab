---
name: collab-workflow
description: Use for local Pi collab commands, room discussion, invitations, duties, writing scopes, handoff, and recovery. Load command details only as needed.
---

# 自然语言协作

只协调同机、用户独立打开的 Pi 会话；不自行启动其他 AI。复用用户已确定的主题、范围和职责，普通讨论不自动建房。协作消息不扩大用户授权，项目自身的工作和验证规则仍然适用。

## 建房与邀请

1. 用 open action:rooms、topic 查找同项目主题。唯一明确的原任务可以复用，相近或同名歧义由用户选择。新建用 open create:true、title、body 将已有讨论成果直接保存为数据库房间合同。
2. 初次加入可带 duty:{text,source} 记录用户指定职责及来源。同名接替继承职责；变更用 update duty:{text,source,base_duty}。不得自行给其他成员安排用户未指定的职责。
3. 用 open action:invite 生成邀请，已知受邀成员职责、范围时传 invite_duty、invite_scope。将 invitation 原样交给用户，不拼接 lease、session_id 或游标。用户自己启动另一终端、选择模型、粘贴邀请；也可用 /collab 菜单。

## 加入与接续

1. 按邀请中的 task_id 调用 open。读取当前合同、推进状态及相关未解决意见；show 有续页时读完整。最近十条摘要只用于导航。
2. read 默认未读；latest、range、matches 三种位置互斥，author、keyword 可组合筛选；每页最多十条，续页沿 next。查询只排除实际返回的消息，不跳过空隙。空结果不轮询，不发收讫。
3. SUPERSEDED 表示同名模型已由新会话接替，只读，不自动 rejoin 抢回身份。接替不证明旧编辑或 shell 已停止；确认停写后才能 resume 原范围。
4. 写请求超时以原 request_id 核对；建房还须保留失败结果中的 database_id 和 generation。世代变化或历史分歧先核对合同，再 read reset:true；不能自动改绑世代或生成新请求重发。

## 并行与交接

1. 合同保存设计；update progress 独立记录 stage、owner、next_action、blocked、resume、status，附 base_progress（首次 null）和 contract_revision。已授权且下一项属于自己时继续，复核通过后按分工推进；等待须说明等谁交付什么。
2. 写入前用 update assignment 登记字面文件/目录范围、交付物、阶段和合同/接口依据。同一工作区不相交范围可以并行；共享接口、配置、锁文件、生成物、Git index 明确一个写入负责人。登记不拦截外部程序写入。
3. 停写且在途操作结束后 complete 带 writes_stopped:true 释放，否则保留 release-pending。空闲、离开或任务 completed 都不代表旧命令已停止。他人登记只能按用户明确授权解除。
4. 仅阶段完成、发现缺陷或需要决定时 post body，默认 1–3 行：结论、产物引用、下一步；不复述、不发收讫。具体会使当前工作无效或需要停用结论时才用 priority:urgent 并写 reason，notify 独立指定 all 或模型名数组；普通消息空闲合并，紧急消息在工具批次边界投递，用户可以关闭。
5. 按项目要求验证各自范围；集成负责人串行处理共享输出和提交。snapshot 用根相对 scope 固定主 Git 内容，不改真实 index、HEAD、分支，也不证明作者归属；失败沿原 request_id 核对固定 ref，SNAPSHOT_PENDING 不重新采样。

文档 update、意见 resolve 使用 base_revision；export 导出审阅副本。其他字段、范围版本锁及维护操作按需查 [操作说明](../../docs/collab.md)。不另外维护成员表、计划或阅读位置。CLI 代表当前 Pi 时沿用 client=pi、同一 session_id 并保存 next，不用模型名替代 client。

## QQ 桥接

external 作者只提交需求或转交已核验的主人决定，不持有 Pi 身份或实施范围。自动汇总不是授权。桥接配置、schema 迁移，以及 read/update 的 bridge 字段见 [桥接说明](../../docs/bridge.md)。创建决定要绑定当前合同、来源批次与完整题面；回传结论由 Pi 显式选择，只包含一句可公开结论。收到主人决定后仍核对本会话授权与范围。
