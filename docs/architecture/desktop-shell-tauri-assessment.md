# 桌面壳从 Electron 迁移到 Tauri 的可行性评估

> 评估时间：2026-11-19
> 评估对象：当前仓库 `v1.5.5` 桌面端（Full / Lite 两个发行版）
> 结论性质：技术可行性 + 成本/收益判断，不是迁移方案设计

## 1. 结论摘要

**技术上可以替换，但不建议整体替换；"轻量"收益主要来自 Lite 版和后端裁剪，而不是换壳。**

- Electron 壳本身约占安装包的一半；Full 版剩余体积来自随包分发的 Node 后端（`ffmpeg-static`、`sharp`、`better-sqlite3`、`sqlite-vec`、`quickjs-emscripten`、`libheif`）与前端产物。
- 换成 Tauri 后仍需携带 Node 运行时（或把后端重写为 Rust），因此 Full 版安装包预计只能从 **145MB 降到约 80–100MB**，不是"几十 MB"。
- Lite 版没有后端，是换壳收益最大的形态：安装包从 **101MB 降到约 15–25MB**，内存和冷启动也有明显改善。
- 迁移成本约 **3–5 人月**（不含后端重写），且会永久增加 macOS WKWebView / Windows WebView2 / Linux WebKitGTK 三套渲染与回归成本。
- 真正的硬缺口只有少数几个：静默 `printToPDF`、`crashReporter`、`session.webRequest`、按窗口隔离的 `session` 与 Chromium 存储目录迁移。它们都能做，但都需要平台分支实现。

**建议：先做 Lite 版 Tauri 试点（4–6 周），Full 版继续用 Electron；同时先做 Electron 体积优化，确认收益上限后再决定是否扩大迁移。**

## 2. 现状盘点（来自仓库实测）

| 项目 | 数据 | 位置 |
| --- | --- | --- |
| Electron 主进程代码 | 8,571 行（不含打包配置与测试） | `electron/*.js` |
| Electron 测试 | 18 个文件、1,695 行 | `electron/__tests__/` |
| 主进程 IPC | 54 个 `ipcMain.handle` + 3 个 `ipcMain.on` | `electron/main.js` 等 |
| preload 暴露面 | 20KB，约 20 组 API；`desktopBridge.ts` 682 行类型定义 | `electron/preload.js`、`frontend/src/lib/desktopBridge.ts` |
| 前端依赖桌面桥 | 64 个文件引用 `window.nowenDesktop`，26 个文件直接依赖 `desktopBridge` | `frontend/src` |
| 后端 | Hono + better-sqlite3 + sharp + ffmpeg-static + sqlite-vec + quickjs + libheif 等 26 个运行时依赖 | `backend/package.json` |
| 后端依赖目录 | 207MB（打包时按白名单裁剪） | `backend/node_modules` |
| 受影响 CI | 14 个工作流直接引用 Electron | `.github/workflows/` |
| 发布形态 | Full/Lite、NSIS/portable、dmg/zip、AppImage/deb、Microsoft Store appx、UGREEN fpk/upk | `electron/builder*.js` |

`v1.5.5` 实际发布产物大小（GitHub Release）：

| 产物 | 大小 |
| --- | --- |
| Windows Full 安装版 `setup.exe` | 145.3MB |
| Windows Full 便携版 `portable.exe` | 200.7MB |
| macOS arm64 dmg | 169.2MB |
| macOS x64 dmg | 178.9MB |
| Linux AppImage | 175.7MB |
| Linux deb | 117.2MB |
| Windows Lite 安装版 | 101.4MB |

值得注意的是：Lite 版注释里写"约 25MB 量级"，实际产物是 101.4MB。原因是 `electron/builder.lite.base.config.js` 的 `files` 显式包含 `node_modules/**/*`，而根 `node_modules` 里仅 `app-builder-bin` 就有 207MB。这属于 Electron 侧可以直接优化的体积问题，与是否换壳无关。

## 3. 为什么换壳的收益被高估

### 3.1 后端是体积大头，且换壳后仍要带 Node

当前 Full 版后端不是 Rust/Go，而是独立 Node 进程：

- `electron/main.js` 通过 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带 Node 启动 `backend/dist/index.js`，因此**不需要额外携带 Node 运行时**。
- 换到 Tauri 后没有可复用的 Node，只能二选一：
  1. 携带官方 Node 24 二进制（`scripts/fetch-node.mjs` 已经在准备这条链路），Windows `node.exe` 压缩后约 20–30MB；
  2. 把后端重写为 Rust，工作量远大于桌面壳迁移，且会重写同步、附件、迁移、插件沙箱等核心资产。

所以 Tauri 省下的是 Electron/Chromium（约 150–200MB 解包、约 85–100MB 压缩），但又要加回 Node 运行时与 Tauri 壳。**Full 版净节省约 40–50%，Lite 版净节省约 75–85%。**

### 3.2 性能收益需要实测，不能按宣传值估算

- 内存：Electron 至少多一个 Chromium 主进程/渲染进程管理开销；Tauri 用系统 WebView，空闲内存通常低 100–200MB。但本项目的后端 Node + SQLite + `sharp` 常驻，会吃掉相当一部分收益。
- 启动：Electron 初始化 Chromium 通常比 WKWebView/WebView2 慢 0.3–1s；但当前启动路径的大头是 `spawn` 后端 + 健康探测（`waitForBackendReady` 最长 30s 超时），壳的差距会被摊薄。
- 渲染：系统 WebView 不再保证固定 Chromium 版本。Windows WebView2 跟随 Edge 自动更新；macOS 跟随 Safari；Linux WebKitGTK 与 Chromium 差异最大。**这是持续成本，不是一次性成本。**

## 4. Tauri v2 能力对照

### 4.1 可以直接覆盖

| 能力 | Tauri 方案 | 备注 |
| --- | --- | --- |
| 窗口/多窗口/无边框/毛玻璃 | `WebviewWindow`、window effects | macOS `vibrancy` + `hiddenInset` 基本可还原 |
| 菜单/托盘/Dock | `tauri-plugin-menu`、`tray-icon` | 需要重写 `electron/menu.js`、`tray.js` |
| 文件关联/单实例/深链 | `single-instance`、bundle `fileAssociations` | macOS `open-file` 事件需另接 |
| 对话框/打开目录/系统打开 | `dialog`、`opener` 插件 | 对应现有 19 处 `dialog.*`、13 处 `shell.*` |
| 通知/权限 | `notification` 插件 | 语音/摄像头权限需按平台处理 |
| 自动更新 | `tauri-plugin-updater` | 签名机制换成 minisign，产物格式不同 |
| 安全存储 | `keyring` / `stronghold` | 与 `safeStorage` 密文不兼容，需要迁移 |
| 日志 | `tauri-plugin-log` | 崩溃转储能力弱于 `crashReporter` |
| 本地 HTTP 代理 | Rust `reqwest` command | 比 Electron `session.fetch` 更直接 |
| Native Messaging 剪藏宿主 | sidecar 或独立可执行文件 | 清单路径与注册方式需重写 |

### 4.2 需要自研或有明显缺口

1. **静默导出矢量 PDF（最大功能缺口）**
   当前实现是离屏 `BrowserWindow` + `webContents.printToPDF`（`electron/main.js:2416-2521`）。Tauri/wry 至今没有统一的 print-to-PDF API：Windows 需要 `ICoreWebView2_7::PrintToPdf`，macOS 需要 `WKWebView.createPDF` 后自行拼页，Linux 需要 WebKitGTK `print_to_stream`，是三条平台代码路径。
   前端已有降级方案（`html2canvas` + `jsPDF`，`exportServiceCore.ts:1624`），但输出是位图、文字不可选、体积大，属于产品体验回退。若接受降级，可先上线；若不接受，需要平台分支或额外 Chromium sidecar（后者等于把 Electron 又装回来）。

2. **崩溃上报**
   `crashReporter.start` 是 Electron 内置能力（`electron/logger.js:147`）。Tauri 需要接 `sentry`/`crashpad` 或平台原生崩溃收集，minidump 路径、符号、上传策略都要重做。

3. **Session / 网络层**
   当前依赖 `session.fromPath`（独立 renderer 存储）、`setPermissionRequestHandler`、`webRequest.onHeadersReceived` 注入 CSP（`electron/main.js:180-200`、`2590`）。Tauri 的 WebView 没有等价的"按窗口独立 session + 响应头改写"抽象，需要：
   - 用自定义协议或本地 HTTP 服务承载前端，在 Rust 侧统一加安全头；
   - 用 Tauri 的权限/能力配置替代部分 permission handler；
   - 如果仍要保留 Chromium 式存储隔离，需要重新设计。

4. **存储与凭据迁移（数据完整性风险）**
   - 离线写队列在 `localStorage`（`frontend/src/lib/offlineQueue.ts`），本地缓存/协作状态在 IndexedDB（`localStore.ts`、`encryptedNotes/*`）。
   - Electron 的存储是 Chromium 格式，Tauri 在 macOS 用 WKWebView、Linux 用 WebKitGTK，**不能直接拷贝 profile 目录**。
   - 因此必须在最后一个 Electron 版本里提供"迁移包导出"，由首个 Tauri 版本导入（离线队列、本地缓存、登录记住的服务器、必要时重新登录）。否则用户在升级瞬间可能丢失未同步的离线编辑，违反仓库的数据一致性契约。

5. **自动更新无法原地接管已有用户**
   electron-updater 使用 `latest.yml`/`latest-lite.yml` + blockmap 差分 + NSIS/dmg/AppImage；Tauri updater 使用 `latest.json` + minisign，安装包格式与签名链不同。Electron 客户端不会因为新版本换成 Tauri 包而自动升级。可选：
   - 一次性"迁移版本"：最后一个 Electron 版本内置下载并启动 Tauri 安装包；
   - 或双应用并存一段时间，引导用户手动切换；
   - 两条路都需要适配 portable、AppImage、Microsoft Store（Store 走独立 URI）三种例外。

6. **打包/签名/发布体系**
   现有 `builder.base.config.js` 有 25KB 的平台逻辑：mac 公证、Windows rcedit/签名、Linux 便携校验、`better-sqlite3` ABI/架构/魔数校验、`sharp`/`ffmpeg` 校验、Store appx。Tauri 侧需要重建同等门禁，14 个引用 Electron 的 CI 工作流需要逐个改。这部分工作容易被低估。

7. **WebView 兼容性回归**
   重编辑器（Tiptap/ProseMirror）、中文输入法、拖拽、选区、剪贴板、PDF.js、`html2canvas`、Mermaid、`MediaRecorder`、复杂 CSS（毛玻璃/动画）在三套 WebView 下都要重跑桌面回归矩阵。Linux WebKitGTK 风险最高。

## 5. 三种路线

### 路线 A：保留 Electron，先做体积优化（低成本，建议先做）

- 修正 Lite 的 `node_modules/**/*` 包含规则，目标是让 Lite 回到注释声称的 20–30MB。
- Full 版按目标平台只带一份 `sqlite-vec` 二进制（当前白名单包含 5 个平台），按平台裁剪 `sharp`/`ffmpeg`。
- 继续使用 `electronLanguages: ["en-US","zh-CN"]`、asar、依赖白名单。
- 预计 Full 安装包可降 20–40MB，Lite 可降 60–70MB；风险远低于换壳。

### 路线 B：Tauri 只替换 Lite 版（推荐作为试点）

- Lite 无内置后端，不涉及 Node sidecar、SQLite、文件夹同步，迁移面最小。
- 保留 `window.nowenDesktop` 同构 API（用 Tauri command/event 实现），前端几乎不用改。
- PDF 导出先用现有浏览器降级方案，或后续补 macOS `createPDF` / Windows `PrintToPdf`。
- 更新用 Tauri updater 独立通道，与 Electron Full 互不影响。
- 预计 4–6 周可出可用内测包；安装包约 15–25MB，是"轻量"叙事最有说服力的形态。

### 路线 C：Full 版整体迁移（不建议当前启动）

- 壳重写 + Node sidecar 管理 + 54 个 IPC + 文件夹同步 + 更新迁移 + 打包体系，约 3–5 人月。
- 若同时把后端重写为 Rust，则 6–12 人月，且会动摇同步/附件/迁移/插件等核心逻辑，不建议。
- 收益：Full 安装包 145MB → 约 80–100MB，内存降低，启动略快。
- 代价：三平台 WebView 永久回归成本 + 更新迁移风险 + 数据迁移风险。

## 6. 迁移必须提前确定的验收门槛

如果决定走路线 B/C，建议先用 2–3 周做技术 spike，按以下门槛决策：

1. **编辑器兼容**：在 macOS WKWebView、Windows WebView2、Linux WebKitGTK 上，Tiptap 输入法、拖拽、粘贴、表格、代码块、Mermaid、PDF.js 无阻断问题。
2. **PDF 导出**：确认可接受的方案（平台原生成 PDF / 降级位图 / 暂不支持），并量化输出质量。
3. **更新迁移**：在真实旧版 Electron 安装上完成一次"Electron → Tauri"迁移，含 portable/Store 例外。
4. **数据迁移**：旧版导出的离线队列与本地缓存在新版完整恢复，断网/弱网场景无丢数据。
5. **原生能力**：托盘、菜单、文件关联、单实例、通知、语音/摄像头权限、剪藏 Native Messaging 全部通过手工验收。
6. **体积/内存**：以 `v1.5.5` 为基线，Full 安装包 ≤ 100MB、Lite ≤ 25MB、空闲内存下降 ≥ 30%，否则收益不足以覆盖成本。

## 7. 最终建议

1. **不要以"Electron 笨重"为唯一理由整体换壳。** 本项目的体积大头是后端运行时与资源，换壳只能解决一部分。
2. **先做路线 A**，用一周验证 Electron 体积下限；如果 Lite 能降到 25MB、Full 降到 110MB 左右，换壳的紧迫性会明显下降。
3. **如果仍要迁移，从 Lite 版开始（路线 B）**，把它当作 4–6 周的独立试点，用真实数据验证 WebView、更新、体积、内存四项指标。
4. **Full 版保持 Electron**，直到出现明确的产品驱动（例如 Windows ARM、低内存设备、安装包硬上限），再考虑路线 C。
5. 无论走哪条路线，**先设计好离线队列/本地缓存/凭据的跨引擎迁移包**，再动桌面壳；否则升级即数据风险。
