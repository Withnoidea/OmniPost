# OmniPost Desktop — Studio / Analytics / Settings

Electron + Vite + React / TypeScript + TailwindCSS + Lucide。Zinc 暖深灰底色、陶土强调色、无边框圆角窗口与安全 IPC；无需浏览器外壳或假的后端接口。

## 工程结构

```text
apps/desktop/
├── package.json                  Electron 入口与 dev/build/preview
├── electron.vite.config.ts       main / CJS preload / React renderer 三路构建
├── tsconfig.json                 strict / noUnused / exactOptionalPropertyTypes
├── src/
│   ├── main/
│   │   ├── index.ts              窗口、安全 IPC、Fetcher、代理、生命周期
│   │   ├── studio.ts             AI / Processor 调度、密钥加密、并发读合并
│   │   └── security.ts           UUID、输入、真实路径、图片格式校验
│   ├── preload/index.ts          仅白名单 API，webUtils 获取真实拖入路径
│   ├── shared/contracts.ts       判别联合 Reply、事件、设置与资产类型
│   └── renderer/
│       ├── App.tsx               外壳、导航、Fetcher 卡片、拖入、队列
│       ├── StudioPanel.tsx       平台 Tab、AI 生成/编辑/复制、FFmpeg 开关
│       ├── Analytics.tsx         本地 KPI、7 日 SVG 趋势、平台环图
│       ├── SettingsDialog.tsx    API / 代理 / FFmpeg 统一设置
│       ├── bridge.ts             类型化 Reply 解包与安全错误显示
│       ├── model.ts              单调事件合并与格式化
│       ├── styles.css            设计 token、语义样式、微交互、减弱动效
│       └── main.tsx / index.html React 入口 / CSP
└── tests/desktop.test.mjs         10 项离线边界测试
```

## 启动

```powershell
npm install                       # 已安装依赖可跳过
npm run dev                       # 根目录启动 Windows 桌面窗口 + HMR
npm run typecheck                 # Core + Desktop
npm test                          # 69 Core tests
npm run desktop:test              # 10 Desktop tests
npm run desktop:build             # 不是 EXE 安装包
npm run preview --workspace @omnipost/desktop
```

Node >=22.12，Electron 44 / electron-vite 5 / Vite 7。开发端口固定 127.0.0.1:5173；不要启动两个 dev 服务。predev 自动检查 Electron runtime。便携 `yt-dlp / ffmpeg / ffprobe / node` 位于 `resources/bin/win32-x64`，通过绝对路径使用，不要求设置 PATH。新克隆缺失二进制时由开发者运行 `npm run setup:tools`；后续安装包需配置 extraResources。本次不声称已产出安装包。

## 真实工作流

1. **Fetcher**：`scheduler.fetchMetadata(url, {proxy})`，20 秒独立执行期限。只取元数据与封面，不等待视频大文件；成功后 `AWAITING_MEDIA`。
2. **挂载**：系统文件选择或真正 OS 文件拖入，通过 preload 的 `webUtils.getPathForFile()` 得到路径。`attachLocalMedia` 复制、ffprobe 校验、SHA256 后 `READY`。不移动用户文件；挂载显示不定进度而不伪造百分比。
3. **AI**：元数据就绪即可改写，不依赖视频；选择小红书 / B站 / 抖音 / 快手，单平台或全平台生成。主进程直接调用 `AIRewriter.rewriteMultiPlatform`，每个平台独立原子保存 `rewritten.json`。显示真实执行阶段而不是模拟 token 流。无自动付费重试；取消保留已保存结果。
4. **人工编辑**：标题、正文、标签、钩子或分区可微调。点击「保存微调」校验格式并携带 `updatedAt` 防止覆盖另一版本。未保存草稿切 Tab/Studio/Analytics 不丢失，但关闭窗口或刷新会丢失，务必显式保存。有草稿时禁止重新生成。复制会复制当前可见文案（包括未保存微调）。
5. **FFmpeg**：挂载后即可开启，独立于 AI。真实 stderr `out_time_us` 驱动进度；完成后 `PROCESSED_READY`，可重新处理，原片保留。详细输出事务和元数据边界见 [processor.md](processor.md)。
6. **监控**：只统计本地任务与 `.operations/*.json`。任务指标显示视频就绪数 / 全部任务、已转码数；流量是每个任务最终挂载/下载视频的字节数，不含代理重试、元数据或派生视频；重复绑定到不同任务分别计数。AI 次数为发起的尝试，Token 仅使用服务返回值，不估算费用；平均处理时长取成功流水线。历史未记录操作不会被反向推算。趋势以 UTC 日期分桶，平台分布是成功保存次数，不是已发布数量。
7. **发布**：四个平台明确显示「待配置账号 / Pending Profile」，发布数/播放量均为 `—`。没有虚构账号、平台流量或可用的发布按钮。

## IPC

`window.electronAPI` 暴露：

- Fetcher：`snapshot / fetchMetadata / selectAndAttach / attachDroppedFile / assets / cancel / onTask`
- Studio：`library / rewrite / saveCopy / processMedia / cancelStudio / onStudio`
- 配置：`studioSettings / saveStudioSettings / setProxy`
- 监控与窗口：`analytics / openAssets / copyText / windowControl`

完整类型位于 `src/shared/contracts.ts`。返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`；不返回原始 provider 错误、工具 stderr 或密码。

renderer 不可直接访问文件系统、Node、任意 IPC 或浏览器外跳；启用 contextIsolation / sandbox，拒绝导航、子窗口与权限申请。每条 IPC 都校验窗口身份、主 frame 和来源。图片仅从 manifest 白名单读取，检查真实路径及 JPEG/PNG/WebP 格式。AI 请求只在主进程发起，renderer 不拿到已保存的 API Key。

## 设置与存储

- 开发库 `.omnipost`，配置 `.omnipost/.desktop`；打包后 library 使用 userData。测试可显式设置 `OMNIPOST_DATA_DIR`，不会注入生产样例。
- Key 与带凭据的代理使用 Electron safeStorage（Windows 系统加密）。若不可用，凭据只保留本次内存，不明文写盘，界面提示。
- 模型支持 DeepSeek / OpenAI / Ollama 自定义 Base URL；本地 HTTP 仅允许 loopback，其他地址必须 HTTPS。不要包含 `/chat/completions`。修改服务 origin 默认清除旧 Key，避免向另一个服务发送它。
- 代理只用于 Fetcher，不接管系统流量或 LLM。Pill 表示配置，不声称已测通。
- Studio 设置和代理分别原子提交；若后一组失败，前一组已保存，不冒充跨文件全局事务。
- 关闭窗口等待 Fetcher、LLM 与 FFmpeg 取消清理。并行素材读取在主进程合并，避免提交完成事件与页面刷新争夺处理锁。

## 验收

参见 [OVERNIGHT_PROGRESS.md](../OVERNIGHT_PROGRESS.md)。在线 YouTube 实测曾返回 AUTH_REQUIRED，未声称无凭据抓取通过；离线流程使用明确标注的自制 FFmpeg 视频和 loopback Mock LLM，测试不需要 API 费用。
