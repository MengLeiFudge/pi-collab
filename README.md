# Pi Collab

同一台电脑上，由用户独立启动的 Pi 会话可以按主题建房、讨论合同、审阅改动和分工。插件不启动其他 AI。模型名称来自 Pi；同名模型的新会话接替旧会话，继承职责。

## 安装

需要 Node `^22.19.0 || >=24.0.0`，以及 Pi 1.0.4 或更新版本（旧版加载时报 HOST_VERSION）。

```bash
pi install git:github.com/MengLeiFudge/pi-collab@v0.1.2
```

仓库已包含编译好的 `dist/`，安装时不需要编译。Pi 只加载包声明的 `dist/index.js` 和 `skills/collab-workflow`。不要同时保留其他方式安装的 collab 扩展，否则会加载两份。

宿主包 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui` 和 `typebox` 声明为 peerDependencies，由 Pi 自身提供。Pi 从 git 安装时使用 `npm install --omit=dev --legacy-peer-deps`，不会在本包里再装一份宿主。

安装或升级后在各会话执行 `/reload`。

## 使用

可以直接告诉 AI：“按刚才讨论的主题建房，你负责实现，给我一个审核者的邀请。”把它生成的邀请粘贴到另一个用户启动的 Pi 会话即可。

- `/collab` 打开主题菜单。
- `/collab 主题` 加入唯一精确匹配；有相近主题时选择候选或新建；没有相关主题时直接创建。
- `/collab copy` 复制自然语言邀请；`/collab info` 显示概况。
- 房间设置可以关闭忙碌时的紧急通知、离开或明确重新接替。

普通留言在空闲时合并送达；忙碌的 AI 可自行 read。紧急留言要求理由，在整个工具批次结束后投递，不中止正在运行的命令。没有新消息时不需要 AI 轮询。

## 数据

房间合同、消息和推进状态保存在 Pi agent 根目录下的 `collab/`，与安装目录分离。根目录取 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。数据库不能放网络共享、同步盘，也不能由 Windows 和 WSL 两个内核同时直接打开。

## 平台与验证范围

支持目标为 Linux、macOS 和原生 Windows。目前只在 WSL 上实际使用过；macOS 和原生 Windows 只做过源码核对和 TypeScript 编译，未实际验证。Node 内置 SQLite 在支持的版本中可能输出实验性提示。用 Bun 或单文件 Pi 启动时，需用 `COLLAB_NODE` 指定兼容 Node 的绝对路径。

## 开发

```bash
npm ci
npm run check
npm run build
```

修改源码后需重新 build 并提交 `dist/`。

工具参数、范围交接、重试、快照和备份恢复见 [操作说明](docs/collab.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
