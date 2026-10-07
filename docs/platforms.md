# 平台与维护边界

扩展通过兼容的 Node 子进程运行编译后的 CLI；不依赖 bash。普通 Node 启动的 Pi 使用自身 Node，Bun 或单文件发行版需设置 COLLAB_NODE 为 Node 的绝对路径。子进程继承扩展在加载时确定的绝对 Pi 数据根，切换项目目录不会切换数据库。

Linux/macOS 使用本机 Git，原生 Windows 使用 git.exe。只有确认是 WSL 且主 Git 为 Windows 程序时才调用 wslpath、设置 WSLENV。Windows Git 首次从 PATH 和默认 Git 安装目录发现，可通过 input.git 指定。非 Git 目录不要求 Git。

范围与项目比较键在 Windows、macOS 和 WSL 的 Windows 默认盘上保守折叠大小写，macOS 另作 Unicode NFC 规范化；这可能在大小写敏感卷上多报冲突。scope 采用根相对的 `/` 分隔字面路径。已有父目录经 realpath 解析；跨盘、越界 junction、.git 别名和直接硬链接文件拒绝。当前冲突键与不可变的 assignment 修订分开保存，scope 登记或接续时检查所有未释放范围；snapshot 描述保持采集时的值。

数据库可放本机文件系统，不支持网络共享、同步盘或 Windows/WSL 跨内核直接共用。可识别的 UNC 路径拒绝；仅 Linux 用 f_type 识别 NFS/CIFS/SMB/9P 等共享类型。macOS/Windows 不套用 Linux 魔数，无法确认的文件系统在 open/维护入口告警继续，日常 read/post 不重复附加；告警不是安全认证。Windows 文件权限沿用户目录 ACL，不声称 chmod 能提供 POSIX 权限保证。

Linux 门禁保留 boot_id 与进程启动时间；其他平台只有 process.kill(pid,0) 明确 ESRCH 才允许接管。EPERM、仍存在的 PID 或未知状态保留门禁，不能凭超时解锁。错误的 maintenance 对象提供门禁 UUID、PID、started_at 和阶段；PID 被复用时也保守等待该进程正常退出，再执行 recover。首版不提供强制清除活进程门禁的入口，不手改库中标记。Windows 原子改名对 EBUSY/EPERM 以 20/50/100/200 毫秒有限退避，失败不删除原文件。主库恢复始终通过 SQLite 写回，不用文件替换。

取消只处理当前实例亲自启动的进程。POSIX 使用独立进程组；原生 Windows 对仍持有的活动 ChildProcess PID 调用 taskkill /T /F。最多等待有限退出宽限，结果不明时返回原请求供核对。WSL interop 的 Linux 进程退出不能证明 Windows 子孙全部退出；快照失败不重新采样，临时 index 在终止不明时保留并返回路径。

目录 fs.watch 只是“数据可能变化”的信号，正文仍从数据库读；没有 filename 的通知也触发同步。监听失败最多重绑三次，然后暂停并提示用户通过 /collab info 或 reload 接续。正常空结果不安排定时读取。

当前验证包含源码、编译及分发结构检查。没有运行测试或运行时探针；macOS、原生 Windows、故障恢复与终止竞态不能据此宣称已实际验证。
