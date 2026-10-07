---
name: collab-workflow
description: Use when the user asks to create or join a local Pi collaboration room, invite another user-started Pi session, assign duties, or coordinate parallel writing scopes and handoff.
---

# 自然语言协作

只协调同机、用户独立打开的 Pi 会话；不自行启动其他 AI。复用用户已确定的主题、范围和职责，普通讨论不自动建房。协作消息不扩大用户授权，项目自身的工作和验证规则仍然适用。

## 建房与邀请

1. 用 open action:rooms、topic 查找同项目主题。唯一明确的原任务可以复用，相近或同名歧义由用户选择。新建用 open create:true、title、body 将已有讨论成果直接保存为数据库房间合同。
2. 初次加入可带 duty:{text,source} 记录用户指定职责及来源。同名接替继承职责；变更用 update duty:{text,source,base_duty}。不得自行给其他成员安排用户未指定的职责。
3. 用 open action:invite 生成邀请，已知受邀成员职责、范围时传 invite_duty、invite_scope。将 invitation 原样交给用户，不拼接 lease、session_id 或游标。用户自己启动另一终端、选择模型、粘贴邀请；也可用 /collab 菜单。

## 加入与接续

1. 按邀请中的 task_id 调用 open。读取当前合同、推进状态及相关未解决意见；show 有续页时读完整。最近十条摘要只用于导航。
2. read 默认未读；latest、range、author、keyword 支持任意历史查询，每页最多十条，续页沿 next。空结果不轮询，不发收讫。
3. SUPERSEDED 表示同名模型已由新会话接替，只读，不自动 rejoin 抢回身份。接替不证明旧编辑或 shell 已停止；确认停写后才能 resume 原范围。
4. 写请求超时以原 request_id 核对；建房还须保留失败结果中的 database_id 和 generation。恢复或历史分歧先核对合同，不能自动改绑世代或生成新请求重发。

## 并行与交接

1. 合同保存设计；progress 独立记录阶段、推进者、下一项和阻塞。已授权且下一项属于自己时继续，不等重复开始指令。
2. 写入前用 update assignment 登记字面文件/目录范围、交付物、阶段和合同/接口依据。同一工作区不相交范围可以并行；共享接口、配置、锁文件、生成物、Git index 明确一个写入负责人。登记不拦截外部程序写入。
3. 停写且在途操作结束后 complete 带 writes_stopped:true 释放，否则保留 release-pending。空闲、离开或任务 completed 都不代表旧命令已停止。他人登记只能按用户明确授权解除。
4. 每阶段一条短 post，写结论、产物引用、下一步由谁做什么。具体会使当前工作无效或需要停用结论时才用 priority:urgent，并写 reason；普通消息空闲合并，紧急消息在工具批次边界投递，用户可以关闭。
5. 按项目要求验证各自范围；集成负责人串行处理共享输出和提交。snapshot 固定审阅内容，不证明作者归属，也不替代范围登记。

命令字段、版本锁和维护操作见 [操作说明](../../docs/collab.md)。不另外维护成员表、计划或阅读位置。
