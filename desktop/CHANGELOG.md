# 变更日志（CHANGELOG）

desktop 独立发包，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
agent 侧的变更与其版本日志见 [`../agent/CHANGELOG.md`](../agent/CHANGELOG.md)。桌面包按白名单把 `agent/` 与 `shared/` 一并打进分发物，故本分支的 agent **与源分支 `feat/2-c-web-service` 同源**（当前 1.6.25）；0.1.0 时壳"不改动 agent"，0.2.0 起因用户反馈"界面太丑"，agent 的**纯展示层**（`agent/public/index.html` 工作台前端）随桌面包一并优化——**`agent/src` 与 `shared/` 相对源分支仍零改动**，agent 逻辑、API 与打包白名单不受影响。

## [0.2.0] - 2026-09-25（分支 feat/5-f-electron-desktop）

**界面体验版**：按"桌面软件该有的样子"重做两个界面（首次配置窗口 + 主窗口加载的工作台前端，后者为 agent 展示层改动），补齐托盘图标品牌图形，并新增面向同学的逐步《桌面版使用手册.md》。所有 IPC 契约（`saveConfig` 三件套）、窗口行为（关窗隐藏到托盘）、服务编排（web-server / my-edge 子进程）与打包白名单**均不变**。

### Changed

- **`src/setup.html` 首次配置窗口重构**（深色，与工作台同一品牌）：字段带图标与右侧提示、密钥「显示/隐藏」切换、逐项红框校验（输入即消错）、保存态（保存中… → ✓ 已保存正在启动）、黄色隐私说明条、页脚"配置错了怎么办"提示；窗口 580×640 → 620×700
- **托盘/窗口图标**：`makeIconBmp` 由"蓝色回字方块"升级为**靛蓝渐变圆角方块 + 白色对勾**（4× 超采样抗锯齿，仍为代码生成 32×32 BMP、仓库不放二进制资产）；同时设为主窗口与配置窗口的 `icon`（开发模式任务栏可见，打包版仍用 exe 图标）
- **`src/main.mjs`**：仅图标与配置窗口尺寸改动，子进程管理 / 生命周期 / IPC 未动

### Added

- **《桌面版使用手册.md》**（仓库根）：给同学的分步操作手册——装 / 首次配置 / 每天怎么用（开题目页 → 探测 → 解题 → 看三态结果 → 止损）/ 排障 FAQ（含"配置填错了怎么重配"）/ 隐私边界；《桌面版说明.md》"同学视角"节改指向本手册

### Verified

- 两个界面经本地 mock + 浏览器逐态走查（视觉验收）；`node --check` 主/预加载通过；`makeIconBmp` 输出经字节级对照验证（BGR 通道序、圆角外透明、对勾白）
- **0.2.0 重新打包实测**（2026-09-25，本机 Windows）：`npm run dist` 走通，产出 `dist/Miaoda Setup 0.2.0.exe`（NSIS）与 `dist/Miaoda-portable-0.2.0.exe`（便携）；`dist/win-unpacked/resources/agent/public/index.html` 确为新版（双栏/结果结构化标记命中）、`resources/shared/` 布局正确、**包内确认无 `.env.local`**（密钥不进分发物）；已删除被取代的 0.1.0 便携版
- **运行链路已实测（2026-09-25，本机 Windows）**：安装版全流程走通——首启配置窗口 → 主窗口加载工作台 → 关窗隐藏到托盘 → 子进程拉起 `web-server` 与受控 Edge（`my-edge` 关闭运行中的 Edge 真实发生）。此项**取代 0.1.0 段末"完整 Electron 链路因 `my-edge` 属破坏性动作未在开发机执行"那条边界**（当时的未验证点，现已验证）
- **仍未验证**（不声称）：安装包未签名（SmartScreen 提示属预期，未在受控策略机器上验）；未在他人机器 / 无 Node 无 Edge 的干净环境验证；卸载残留与升级覆盖安装未测。详见《桌面版说明.md》"验证边界"

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
