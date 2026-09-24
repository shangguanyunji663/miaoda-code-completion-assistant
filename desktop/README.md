# 妙答桌面版（Electron 壳）

一个「壳」，**不复制、不改动 `agent/` 的任何代码**。定位与分支 `feat/4-e-oneclick-launcher`（一键 bat）同目标、不同形态：同学拿到手是**安装版桌面程序**（图标 / 托盘 / 无黑窗口）。

## 它做什么

1. **首次配置**：`agent/.env.local` 不存在时弹出配置窗口（三件套表单 → 写入文件）；分发方预填了就自动跳过。
2. **起服务**：用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）以子进程运行 `agent/src/web-server.mjs`——与 `start-web.bat` **完全同一入口**。
3. **受控浏览器**：CDP 端口已活则直接复用（不折腾你的 Edge）；否则子进程运行 `node src/cli.mjs my-edge`（与 `start-my-edge.bat` 同一入口）并等待端口就绪。
4. **主窗口**：加载 `http://127.0.0.1:8787` 的网页工作台。关闭窗口 = **隐藏到托盘**继续运行（首次有气泡提示），托盘「退出」才真正结束。

日志落在 `%APPDATA%/miaoda-desktop/agent-web.log`（排障用）。

## 开发与构建

```bash
cd desktop
npm install        # 下载 Electron（约 100MB+，一次性）
npm start          # 开发运行（要求 ../agent 已 npm install）
npm run dist       # 打包：NSIS 安装版 + 便携单文件版 → dist/
```

打包结构：`agent/`（含 node_modules）与 `shared/` 经 `extraResources` 原样拷进 `resources/`，因此：

- agent 以普通目录存在（非 asar），`ELECTRON_RUN_AS_NODE` 子进程可直接读写；
- `agent/.env.local` **不会**被打进包（白名单 filter 不含它）——密钥永远在每台电脑上首次配置时生成；
- per-user NSIS 安装（`%LOCALAPPDATA%\Programs\…`）目录可写，运行期写入的 `.env.local` 与日志持久保存。

## 已知边界（如实标注）

- **构建已实测**（2026-09-25，本机 Windows）：`npm install` + `npm run dist` 走通，产出 `dist/Miaoda-portable-0.1.0.exe`（76MB，未签名属预期）；`dist/win-unpacked/resources/` 下 `agent/`（含 node_modules/playwright-core）与 `shared/` 布局核验正确，**包内确认无 `.env.local`**（密钥不进分发物）。NSIS 安装版目标未单独构建（同一管线，产物形态差异而已）。
- **应用运行未实测**：Electron 主进程的完整链路（配置窗口 → 子进程起 web-server → my-edge）会触发 `launchMyEdge` 关闭运行中的 Edge（破坏性动作），开发机上未执行；`electron --version`（v33.4.11）与主进程 `node --check` 已过。首次真机运行请先关掉重要标签页。
- **Windows 打包坑**：electron-builder 解压 winCodeSign 缓存会因其中两个 **darwin 专属符号链接**报「客户端没有所需的特权」——这两个文件 Windows 打包用不到；已手动用 7za 解压到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0` 绕过（解压报 2 个 Sub item Errors 可忽略）。换机器首次打包若再遇此错，同样处理。
- 托盘图标是代码生成的 32×32 BMP（无二进制资产）；要换正式图标，把 `build/icon.ico` 放进 desktop/ 即自动生效。
- Web 工作台本身的能力边界（仅绑 127.0.0.1、solve 会真实提交等）见 `agent/README.md`「网页工作台」节，桌面版不改变其中任何一条。
- 与 `feat/4-e-oneclick-launcher`（一键 bat，1.7.0）互不依赖：嫌装 Electron 麻烦就用 bat 方案，想要"正规软件"体验用本分支。
