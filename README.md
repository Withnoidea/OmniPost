# OmniPost · 全播

跨境短视频智能分发桌面助手。**当前交付：Electron Studio + Fetcher + 四平台 AI 改写 + FFmpeg 处理 + Analytics + 统一设置。发布入口明确标为待配置账号，尚未实现 RPA 发布。**

技术路线：Electron + React + TailwindCSS + Lucide；核心采用 TypeScript/Node.js。AIRewriter、FFmpeg Processor 以及后续 Playwright Publisher 都消费已提交的本地资产，不反向影响原始素材。

## 启动桌面端（Windows）

```powershell
npm install
npm run dev
```

依赖已安装时直接运行 `npm run dev`。Electron 运行时由安装脚本自动准备；本仓库现有的便携 yt-dlp / ffprobe 无需手工配置 PATH。
支持链接解析、代理设置、封面预览、原生选择/拖入 MP4、四平台 AI 改写与人工编辑、真实 FFmpeg 进度、独立 Analytics 及重启恢复。开发默认复用 `.omnipost` 素材库，**不要同时启动占用同目录的 CLI 调度器**。

- `npm run desktop:build`：桌面类型检查 + 构建（不是安装包）。
- `npm run desktop:check`：桌面严格 TypeScript 检查。
- `npm run desktop:test`：10 项离线桌面边界/状态测试。
- `npm test`：69 项核心测试（包括原有 37 项 Fetcher 回归，离线全通过）。
- `npm run typecheck`：整仓 Core + desktop 严格类型检查。

工程设计、IPC 契约、数据目录见 [桌面端文档](docs/desktop.md)；完整验收记录与 Mock 复现步骤见 [OVERNIGHT_PROGRESS.md](OVERNIGHT_PROGRESS.md)。

## 工程目录

```text
OmniPost/
├─ apps/desktop/                         [已实现] Electron + Vite 桌面工作台
│  ├─ src/main/                         窗口、安全 IPC、加密设置、Studio 调度
│  ├─ src/preload/                      sandbox 安全桥接（输出 CJS）
│  ├─ src/shared/                       IPC 类型契约
│  └─ src/renderer/                     React + Tailwind Studio / Analytics / Settings
├─ packages/core/src/
│  ├─ index.ts                          对外类型/API
│  ├─ fetcher/                          [本轮已实现]
│  │  ├─ types.ts                       请求、状态、资产、事件契约
│  │  ├─ config.ts                      链接/代理/参数验证、便携工具定位
│  │  ├─ errors.ts                      稳定错误码与脱敏错误信息
│  │  ├─ process.ts                     子进程、流式输出、进程树取消
│  │  ├─ downloader.ts                  yt-dlp 参数、ffprobe、元数据归一化
│  │  ├─ store.ts                       日志、独占锁、原子提交、完整性摘要
│  │  └─ scheduler.ts                   并发队列、超时、取消、重试、恢复
│  ├─ processor/                        [已实现] 变速/裁剪/音轨/元数据清理
│  ├─ rewriter/                         [已实现] 兼容 API、四平台 Prompt、逐平台落盘
│  └─ publisher/                        [后续] Playwright 平台适配器/HITL
├─ resources/
│  ├─ tools.lock.json                   固定版本、下载地址、SHA-256
│  ├─ THIRD_PARTY_NOTICES.md             二进制依赖许可与再分发提醒
│  └─ bin/win32-x64/                    [本机已准备；大文件不进 Git]
│     ├─ yt-dlp.exe
│     ├─ ffmpeg.exe
│     ├─ ffprobe.exe
│     ├─ node.exe                       YouTube 提取所需 JS runtime
│     └─ tools.manifest.json            安装后二进制摘要
├─ tools/
│  ├─ fetch.ts                          下载 CLI
│  ├─ rewrite.ts                        文案改写 CLI
│  ├─ setup-tools.mjs                   构建时准备便携依赖
│  └─ verify-tools.mjs                  便携工具完整性/可执行验证
├─ tests/                               离线单元、进程树、便携工具集成测试
├─ docs/architecture.md                 模块边界与后续交付计划
├─ docs/fetcher.md                      下载 API、持久化、错误码和验收边界
├─ docs/rewriter.md                     改写 API、配置、输出 schema 和验收边界
└─ .omnipost/                           默认开发数据目录；不进 Git
```

## Fetcher 能力

- 仅接收 HTTPS YouTube/TikTok **单视频**链接；支持 YouTube watch、youtu.be、shorts，TikTok 完整/短分享链接。自动移除追踪参数，不会展开播放列表。
- 默认下载视频、**原始格式/原始字节封面**、yt-dlp 原始 info JSON；另生成供 AI 使用的规范化元数据。
- **元数据优先**：`fetchMetadata` / `--info-only` 只抓信息与封面，独立落盘后进入 `AWAITING_MEDIA`，不等待视频实体。
- **手动绑定**：`attachLocalMedia` / `--attach` 将 IDM 等外部工具下载的 MP4 复制到任务目录，校验通过后进入 `READY`；不修改用户原文件。
- HTTP/HTTPS/SOCKS5/SOCKS5H 代理，支持 URL 编码的用户名和密码。每个任务独立配置，不污染全局环境。
- 元数据与媒体两条独立有界队列（每条默认 2，范围 1–8）；总超时、网络超时、进度/元数据/成功/错误事件。元数据默认 15 秒截止、零网络重试；完整下载保留有限重试。
- 取消与超时终止子进程树，包括正在运行的 FFmpeg；失败和取消保留临时素材。
- 任务日志持久化，成功资产原子提交；重启恢复提交窗口，未完成抓取标记 `interrupted`，中断绑定恢复为 `AWAITING_MEDIA`；不盲目自动重跑。
- 下载完成后使用 ffprobe 检查视频流及有效时长；视频、封面生成 SHA-256。
- 无 shell 拼接、禁用外部 yt-dlp 配置、显式指定便携工具绝对路径。代理凭据不进入任务日志/事件。

## 开发运行（Windows x64）

以下安装步骤面向开发/构建人员，**不是最终用户安装步骤**。目前尚未提供 Electron 安装包。

```powershell
npm ci
# 仅首次克隆需要：下载锁定版本，校验 SHA-256；当前工作区已经准备好
npm run setup:tools
npm run verify:tools
npm run build
npm test
```

准备脚本当前只提供 Windows x64 依赖包。固定版本为 yt-dlp `2026.08.19`、FFmpeg/ffprobe `9.0.2`、Node `22.23.3`。运行下载时不查询 PATH、不联网安装工具，也不自动更新 yt-dlp。工具已存在时准备脚本拒绝覆盖，更新应先停止所有任务并准备新的版本化资源目录。

```powershell
# 替换为你拥有权利或获授权的视频链接
npm run fetch -- "https://www.youtube.com/watch?v=VIDEO_ID_11"

# 显式代理（无代理时默认直连，不继承 HTTP_PROXY/HTTPS_PROXY）
npm run fetch -- "https://www.tiktok.com/@creator/video/1234567890" --proxy "http://127.0.0.1:7890"

# 凭据避免放进命令行历史；密码中的 @ 等字符必须 URL 编码
$env:OMNIPOST_PROXY = 'socks5://user:p%40ss@127.0.0.1:1080'
npm run fetch -- "https://youtu.be/VIDEO_ID_11" --timeout-ms 1800000 --concurrency 2
Remove-Item Env:OMNIPOST_PROXY

# 查看已持久化任务
npm run fetch -- --list
```

CLI 为逐行 JSON 输出；成功打印 `taskId`、`state`、`awaitingMedia` 与 `assetDirectory`。元数据已落盘但尚无视频也返回 `0`；失败（含绑定失败后仍等待媒体）返回 `1`，Ctrl+C 返回 `130`。`--help` 列出全部参数。上述 `VIDEO_ID_11` 为占位符，不是真实视频 ID。

### 元数据先行 + 外部视频绑定

```powershell
# 1. 只抓标题/简介等元数据和原封面，不下载音视频
npm run fetch -- "https://youtu.be/VIDEO_ID_11" --info-only --proxy "http://127.0.0.1:7890"

# 2. 用 IDM 等工具完成视频下载后，使用上一步回执中的 taskId（可跨进程/重启）
npm run fetch -- --attach "<taskId>" "D:\IDM\video.mp4"
```

两次调用需使用同一个数据根（默认当前目录下 `.omnipost`；自定义时两次都传 `--data`）。元数据通道不会被大文件下载占满；`--timeout-ms` 可覆盖所选操作的截止时间。源站/代理延迟不可控，15 秒上限不等于保证几秒成功，超时会明确失败并保留工作目录。

### 嵌入调用

```ts
import { DownloadScheduler, resolvePortableTools } from './packages/core/src/index.js';

const scheduler = await DownloadScheduler.create({
  dataDirectory: '/absolute/path/to/user-data',
  tools: resolvePortableTools('/absolute/path/to/resources'),
  concurrency: 2,
  onProgress: (taskId, progress) => console.log(taskId, progress),
  onSuccess: (task, asset) => console.log(task.id, asset.metadata.title),
  onError: (task, error) => console.error(task.id, error.code, error.message),
});

try {
  const queued = await scheduler.enqueue({
    url: 'https://www.youtube.com/watch?v=VIDEO_ID_11',
    proxy: 'http://127.0.0.1:7890',
    timeoutMs: 30 * 60_000,
  });
  const finished = await scheduler.waitFor(queued.id);
  if (finished.state === 'completed') {
    // 后续模块只消费此目录，不读取 work/。
    console.log(scheduler.getAssetDirectory(finished.id));
  }
} finally {
  await scheduler.close();
}
```

轻量模式不需要新建服务，将上例 `try` 内的完整下载逻辑替换为（`url` / `proxy` / `localFilePath` 来自调用方）：

```ts
const waiting = await scheduler.fetchMetadata(url, { proxy, timeoutMs: 15_000 });
if (waiting.state === 'AWAITING_MEDIA' && !waiting.error) {
  // 此时 waiting.metadataAsset 已可供 AI 使用；也可以关闭调度器，稍后重开绑定。
  const ready = await scheduler.attachLocalMedia(waiting.id, localFilePath);
  if (ready.state === 'READY' && ready.asset) {
    // 视频名从 ready.asset.video.file 读取，不硬编码为 media.mp4。
    console.log(scheduler.getAssetDirectory(ready.id), ready.asset.video.file);
  } else {
    console.error(ready.error); // 绑定失败保留元数据，可在原任务重新绑定
  }
} else {
  console.error(waiting.error);
}
```

`fetchMetadata` 与 `attachLocalMedia` 都等待当前操作收尾；操作失败按 `state/error` 返回，非法输入/任务状态等前置错误仍抛出 `FetcherError`。完整下载的 `enqueue()` 与 `completed` 状态保持兼容。

Electron 后续将使用 `app.getPath('userData')` 存数据，`process.resourcesPath` 定位 `extraResources`。不能将 EXE 打进 `app.asar` 后直接执行。UI renderer 不直接访问进程或账号文件。

## 产物

```text
.omnipost/
├─ jobs/<task-id>.json                   状态日志；不含代理密码
├─ locks/<pid>-<uuid>.lock               同一数据目录只能有一个调度器
├─ work/<task-id>/                       进行中/失败/取消素材，不自动清理
└─ assets/<task-id>/                     元数据或完整媒体提交后出现
   ├─ media.mp4                         完整下载模式；优先无重编码合并/重封装
   ├─ media.<attempt-id>.mp4             手动绑定副本；以 manifest 提交为准
   ├─ cover.<jpg|png|webp|…>             不压缩、不转换原封面
   ├─ media.info.json                   源站原始元数据
   ├─ metadata.json                     标题、简介、语言、标签等规范化数据
   ├─ metadata.manifest.json            轻量模式的信息/封面提交凭据
   └─ manifest.json                     视频就绪后才出现；字节数、SHA-256
```

**目录存在不代表视频就绪。** `AWAITING_MEDIA` 只可消费元数据；Processor/Publisher 必须检查 `READY` 或兼容的 `completed` 及完整 `manifest.json`。绑定通过带取消信号的流式复制、ffprobe（容器/视频流/正时长）与 SHA-256 校验，失败文件留在独立尝试目录，不破坏已提交封面与信息；不做逐帧完整解码或源链接内容匹配。

下载阶段的合并/重封装**不是**去重转码。1.02× 变速、1% 裁剪、音轨重采样、清除元数据将在下一模块实现，输出到新的衍生资产目录，不改写原始资产。

## AIRewriter：先改文案，再绑定视频

`AWAITING_MEDIA` 阶段即可使用，保持原任务状态不变。仅发送筛选后的标题/描述/标签/已有字幕文本，不上传视频或整份 info JSON。

```powershell
# 同样需要先 npm run build；taskId 来自 fetch --info-only 的回执
$env:OMNIPOST_LLM_API_KEY = '<你的 DeepSeek Key>'
npm run rewrite -- '<taskId>' --platform xhs,bili

# OpenAI 兼容端点：显式配置对应的 Key、API 根与模型
npm run rewrite -- '<taskId>' --platform dy,ks --base-url 'https://api.openai.com/v1' --model 'gpt-4o-mini'
Remove-Item Env:OMNIPOST_LLM_API_KEY
```

- 支持四平台完整名称和 CLI 别名 `xhs,bili,dy,ks`；默认 DeepSeek，可配置本地 Ollama 的 `/v1` 地址和实际安装模型。
- 配置 `apiKey/baseURL/model/temperature`，默认每平台60秒截止；可关闭 JSON mode 适配旧服务，无隐式付费重试。
- 各平台成功即原子合并到 `assets/<taskId>/rewritten.json`，失败保留此前成功结果及原素材，不等待视频实体。
- 完整平台 API、JSON schema、配置与事件见 [Rewriter 文档](docs/rewriter.md)。只继承 OmniPost 专用环境变量，不自动读取其他工具的 `OPENAI_API_KEY`。
- 字幕仅有 URL 时只提供可用语言信息，不自动下载字幕或虚构内容；“热门话题”不是实时热榜，分区是建议。

## 验证与边界

`npm test` 当前 60 项通过、0 跳过：原37项 Fetcher/便携工具测试保持通过，新增23项 Rewriter 离线 Mock/真实本地 HTTP/CLI 测试。覆盖改写 JSON 容错、逐平台保存、部分失败、并发锁、密钥隔离、超时取消与源信息变化保护。

集成测试使用自制音视频 + 本地认证 HTTP 代理，在 **PATH 清空** 的情况下执行真实 yt-dlp、FFmpeg 合流和 ffprobe，并核对原始封面字节；额外验证元数据模式 **零音视频请求**、真实 API/CLI 本地绑定；不需要外网。未准备便携工具时该项明确标记为 skipped，其余测试仍可运行。

- 尚未用用户实际链接/代理验收 YouTube/TikTok 线上源站可用性，源站风控不等同于调度器故障。
- 无封面、缺失视频流、元数据无效不会被标记成功。不能保证每个受限视频都可下载。
- 不提供 DRM、付费限制、登录或验证码绕过；遇到此类问题返回明确错误。无水印取决于源站提供的媒体，不做水印擦除承诺。
- 源站提供多少语言信息就保留多少；本轮不做翻译、不额外下载字幕，不虚构多语言标题。
- 原始 info JSON 可能含签名媒体 URL，应视为敏感本地文件。Windows 继承用户目录 ACL，POSIX 新建目录/日志使用 0700/0600。代理密码在工具运行时仍可能被同权限本机进程从进程参数读取，不能将环境变量用法理解为操作系统级秘密隔离。
- 此轮没有 UI、Playwright 分发、账号隔离、stealth 或 HITL 空实现。AI 改写产物需人工审稿，并未接入自动发布。只下载你有权处理与发布的内容，并遵守平台条款。

更多细节见 [下载模块契约](docs/fetcher.md) 和 [架构设计](docs/architecture.md)。
