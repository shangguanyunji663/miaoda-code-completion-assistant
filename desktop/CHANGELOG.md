# 变更日志（CHANGELOG）

desktop 独立发包，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
agent 侧的变更与其版本日志见 [`../agent/CHANGELOG.md`](../agent/CHANGELOG.md)（本包不改动 agent，故 agent 版本号与本包无关）。

## [0.1.0] - 2026-09-25（分支 feat/5-f-electron-desktop）

**首个版本**：Electron 桌面壳——把「受控浏览器 + 网页工作台」装成 Windows 安装版/便携版桌面程序。`agent/` 与 `shared/` 代码**零改动**，桌面版只是壳：用 Electron 自带 Node 以子进程运行 agent 的既有入口（`web-server.mjs` / `cli.mjs my-edge`），不复制、不改写任何 agent 逻辑。

### Added

- **首次配置窗口**：`agent/.env.local` 不存在时弹出三件套表单（`setup.html` + preload，contextIsolation 下唯一 IPC 桥 `saveConfig`）；分发方预填则自动跳过；未保存即关窗则给出人话提示后退出
- **服务编排**：`ELECTRON_RUN_AS_NODE` 子进程运行 `agent/src/web-server.mjs`（与 `start-web.bat` 完全同一入口）；CDP 端口已活则**复用受控浏览器不重启 Edge**，否则子进程运行 `node src/cli.mjs my-edge`（与 `start-my-edge.bat` 同一入口）并轮询等待端口（45s 超时给气泡提示）
- **主窗口 + 托盘**：加载 `http://127.0.0.1:8787`（`WEB_PORT` 可配）；关窗 = 隐藏到托盘继续运行（首次气泡提示），托盘「退出」才真正结束；单实例锁（二次启动唤起已有窗口）；托盘图标由代码生成 32×32 BMP（仓库无二进制资产）
- **打包配置**：extraResources 白名单拷贝 `agent/`（含 node_modules）与 `shared/`，**`.env.local` 不进分发包**（密钥每台机器首次配置时生成）；win 目标 = NSIS（per-user 一键安装）+ portable 单文件
- **日志**：agent 子进程全部输出落 `%APPDATA%/miaoda-desktop/agent-web.log`，排障入口见《桌面版说明.md》

### Verified

- `npm install` → `npm run dist` **全链路实测**（2026-09-25，本机 Windows）：产出 `dist/Miaoda-portable-0.1.0.exe`（76MB，未签名属预期）；`dist/win-unpacked/resources/` 下 `agent/`（含 node_modules/playwright-core）与 `shared/` 布局核验正确；**包内确认无 `.env.local`**
- `electron --version`（v33.4.11）与主进程 `node --check` 通过
- **未实测**：Electron 主进程的完整运行链路（配置窗口 → 子进程 → 托盘）——`my-edge` 会关闭运行中的 Edge，属破坏性动作，开发机上未执行；NSIS 安装版目标未单独构建（与便携版同一管线）

### Known Issues

- electron-builder 在 Windows 上解压 winCodeSign 缓存时，会因其中**两个 darwin 专属符号链接**报「客户端没有所需的特权」（Windows 打包用不到它们）：手动 `7za x -y -snld <缓存>.7z -o<缓存目录>/winCodeSign-2.6.0` 绕过即可，解压报 2 个 Sub item Errors 可忽略（见 desktop/README.md）
- 关窗即隐藏到托盘的行为对第一次用的人可能意外——已有一次性气泡提示说明；若反馈不佳可加「关闭时询问」设置项
