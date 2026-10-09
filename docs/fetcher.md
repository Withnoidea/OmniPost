# Fetcher API 与持久化契约

## 最小解耦方案

保留现有 `DownloadScheduler`、`AssetStore`、便携工具与错误/事件体系，不引入服务、依赖或新的框架。完整下载的 `enqueue()`、`completed`、原 `AssetManifest` 保持兼容。

| 文件 | 增量职责 |
|---|---|
| `types.ts` | `mode`、`MetadataManifest`、`AWAITING_MEDIA` / `READY`、`onMetadata` |
| `downloader.ts` | 复用安全参数与元数据规范化；新增 `--skip-download --dump-json` 路径 |
| `store.ts` | 元数据独立原子提交；本地媒体流式复制、独立尝试目录与完整 manifest 提交 |
| `scheduler.ts` | 新 API、独立元数据队列、挂载/取消/重启恢复 |
| `config.ts` / `errors.ts` | 按操作检查便携工具；增加 `INVALID_MEDIA` / `INVALID_STATE` |
| `tools/fetch.ts` | `--info-only` / `--attach`；保留旧 CLI |

## 公共 API

从 `packages/core/src/index.ts` 导出，编译入口为 `dist/packages/core/src/index.js`。

- `DownloadScheduler.create(options)`：验证配置，独占数据目录，加载日志并恢复中断状态；**不预先检查所有工具**，只查看任务/恢复日志无需工具存在。核心不会下载工具。
- `enqueue({ url, proxy?, timeoutMs? })`：保持完整下载；先持久化 `queued`，返回任务快照。相同链接允许重复入队，每个任务使用独立 UUID。
- `fetchMetadata(url, { proxy?, timeoutMs? } = {})`：仅抓取原始 info JSON 和封面，返回当前操作收尾后的任务。成功为 `AWAITING_MEDIA`，`task.metadataAsset` 可立即供 AI 消费，`task.asset` 尚不存在。
- `attachLocalMedia(taskId, localFilePath)`：仅接受 `AWAITING_MEDIA` 任务；复制已下载完成的 `.mp4`，探测/提交后返回 `READY`。可在新调度器中绑定旧任务，无需代理或 yt-dlp。相同任务同时绑定会 reject `INVALID_STATE`。
- `waitFor(id)`：等待当前操作收尾，返回完整快照；`AWAITING_MEDIA` 是可停留状态，不会一直等待用户选文件。**任务执行失败通过 state/error 返回，不 reject**；不存在的任务 ID 则 reject。
- `cancel(id)`：取消排队或运行操作，等待收尾；已完成/不存在/空闲等待媒体的任务无操作。取消绑定恢复 `AWAITING_MEDIA` 并记录 `CANCELLED`，元数据不删除。
- `retry(id, { proxy?, timeoutMs? })`：仅可重试 `failed` / `cancelled` / `interrupted`，保持原模式，创建新 ID 和目录，不覆盖旧文件。代理必须重新提供。**绑定失败通常仍为 `AWAITING_MEDIA`，应对原任务再次调用 `attachLocalMedia`**，不重新抓取元数据。
- `getTask(id)` / `listTasks()`：返回深拷贝，外部修改不影响调度。
- `getAssetDirectory(id)` / `getWorkDirectory(id)`：生成已校验 UUID 的路径；目录存在不代表视频就绪。
- `close()`：拒绝新任务、取消正在排队/运行的操作、等待收尾、释放目录锁；保留空闲 `AWAITING_MEDIA`，可重复调用。

所有方法均沿用现有错误协议：非法参数、工具缺失、非法状态等前置错误 reject `FetcherError`；入队后的失败返回任务的 `state/error` 并触发 `onError`。即使返回 `AWAITING_MEDIA`，调用方也应检查 `task.error` 区分元数据成功与绑定失败。

`create` 的可选第二参数是低层 `ProcessRunner` 测试注入点，生产调用不应传入。

### 配置与工具依赖

| 字段 | 默认值 | 限制 |
|---|---|---|
| `dataDirectory` | 必填 | 建议应用私有、本地文件系统目录 |
| `tools` | 必填 | ytDlp/ffmpeg/ffprobe/node 路径；按操作校验所需文件 |
| `concurrency` | 2 | 整数 1–8；元数据/媒体两条队列各自的并发上限 |
| `timeoutMs` | 1,800,000 | 整数 1–86,400,000；完整下载/本地绑定从出队到校验提交前的截止时间 |
| `metadataTimeoutMs` | 15,000 | 同上；元数据模式独立截止时间；请求 `timeoutMs` 可覆盖 |
| `socketTimeoutSeconds` | 30 | 整数 1–300；元数据模式使用 `min(5, 配置值)` |
| `retries` | 3 | 整数 0–10；完整下载有限重试，元数据模式固定为 0 |

- 元数据模式只需要 yt-dlp + 便携 Node，不依赖 FFmpeg/ffprobe；使用 `--skip-download --dump-json --no-simulate --write-info-json --write-thumbnail`，不设置视频格式/合并/重封装参数，不记录 stdout 原始 JSON。
- 本地绑定只需要 ffprobe；流式复制和 SHA-256 由 Node 核心完成，不访问源站。
- 完整下载需要四个便携工具，FFmpeg 与 ffprobe 必须同目录。优先 mp4/m4a，必要时回退最佳源并重封装 MP4；不做有损重编码。
- 元数据不会被大文件占满的媒体队列阻塞，但同类任务仍会排队。下载与本地绑定共用媒体队列，两类任务同时运行时总并发最多为 `2 × concurrency`。
- 15 秒是默认**运行截止时间**，不含队列等待；源站、DNS、代理延迟不可控，不承诺每次几秒成功。超时终止子进程树；进入原子提交后仍需等待提交收尾，不能为抢截止时间回滚素材。

### CLI

```powershell
npm run build
npm run fetch -- "https://youtu.be/VIDEO_ID_11" --info-only --proxy "http://127.0.0.1:7890"
npm run fetch -- --attach "<返回的 taskId>" "D:\IDM\video.mp4"
npm run fetch -- --list
```

`VIDEO_ID_11` 为占位符。自定义数据根需对两个命令都传同一个 `--data DIRECTORY`。`--info-only` 可接受多个链接；`--attach` 只接受一个文件，不能与 `--info-only` / `--list` 同用。`--timeout-ms` 覆盖当前操作默认时限。

成功回执包含 `taskId/state/awaitingMedia/assetDirectory`。`AWAITING_MEDIA` 且无错误即元数据成功，退出码 0；任务失败（包括绑定失败后仍等待媒体）退出码 1；Ctrl+C 为 130。代理与外部文件路径不进入回执。

### 状态与回调

```text
完整下载（保持兼容）：
  queued → downloading → finalizing → completed

元数据：
  queued → fetching_metadata → finalizing → AWAITING_MEDIA

手动绑定：
  AWAITING_MEDIA → queued → attaching → READY
                              └─ 失败/取消/超时 → AWAITING_MEDIA + error

抓取失败/取消：failed / cancelled；抓取中崩溃且无提交：interrupted
元数据已提交：恢复 AWAITING_MEDIA；绑定中崩溃：恢复 AWAITING_MEDIA + INTERRUPTED
完整 manifest 已提交但日志未更新：恢复 READY（metadata 模式）或 completed（旧下载）
```

- `mode?: 'download' | 'metadata'`，旧日志缺失时按 `download` 处理；原有小写状态不改名，只增量增加所需新状态。
- `onEvent`：`state` / `progress` / `metadata` / `success` / `failure` 判别联合。
- `onProgress(taskId, progress)`：现有音视频下载字节数及可选 total/percent/speed/eta。元数据和绑定阶段用状态事件，不伪造下载进度。分轨下载进度可能从 0 重新开始。
- `onMetadata(task, metadata)`：信息/封面与任务日志都落盘后触发；不会提前触发 `onSuccess`。
- `onSuccess(task, asset)`：仅在 `completed` / `READY` 且完整资产、终态日志落盘后触发。不要据 `percent === 100` 判断成功。
- `onError(task, error)`：失败/取消后的稳定错误码；不暴露原始 stderr。
- 回调收到快照，异常/Promise rejection 被隔离；启动恢复不重放旧事件。进度仅驻内存/随状态转换写入日志。
- 取消到达原子提交检查点之后，若提交成功则以成功为准，不回滚已提交资产。

本轮没有发布浏览器，无假的 `onCaptcha` API。源站登录/验证码失败为 `AUTH_REQUIRED`；Publisher 后续独立提供可暂停的人机协同协议。

## 代理和链接安全

- `proxy` 接受 `http://`、`https://`、`socks5://`、`socks5h://`；可携带 URL 编码 userinfo，不接受路径、查询串或换行。
- 未设置代理时传递 `--proxy ""`，并从子进程环境移除代理变量。不继承开发机环境代理。
- 代理不写入日志、manifest、事件或错误信息。原始 stderr 只保留受限内存尾部用于分类，随后丢弃。
- 子进程使用 argv 数组，`shell: false`；URL 与选项用 `--` 分隔。`--ignore-config` 禁止外部 yt-dlp 配置插入 `--exec` 等副作用。
- 只允许白名单源站的 HTTPS 单视频路径；短链重定向由 yt-dlp 提取器处理。不是对不可信多租户开放的通用 URL 代理服务。
- 代理会短暂出现在 yt-dlp 进程参数中，同权限本机进程仍可能读取。原始 info JSON 可能包含签名媒体 URL，应视为敏感本地文件。

## 文件提交与恢复

### 公共保证

日志 `jobs/<id>.json` 使用同目录唯一临时文件，写入、fsync、rename；POSIX 同步日志父目录。任务/尝试路径使用内部 UUID，不将标题或本地来源路径作为文件名。元数据大小限制 32 MiB，视频/封面要求非空普通文件；视频和封面 flush 后生成 SHA-256。

### 元数据先落盘

1. yt-dlp 只写 `work/<id>/media.info.json` 与 `cover.<原格式>`；源站失败或封面缺失不提交。
2. 校验并写规范化 `metadata.json`、`metadata.manifest.json`，将整个工作目录同盘 rename 到 `assets/<id>`。
3. 持久化 `AWAITING_MEDIA`，最后发 `onMetadata`。此时没有 `manifest.json` 和视频，AI 可先读取元数据。

### 本地媒体绑定

1. 校验源文件后缀 `.mp4`（不区分大小写）、非空普通文件；不接受符号链接。用只读句柄流式复制到 `work/<id>/attachments/<attempt-id>/media.mp4.part`，支持取消，不移动或修改源文件。
2. 复制前后检查源文件大小、mtime/ctime 和复制字节数，拒绝仍在变化的下载文件。重命名 staging 文件，ffprobe 检查 MP4 家族容器、视频流和正时长；计算 SHA-256。不是逐帧解码或内容与源链接匹配验证。
3. 将副本 rename 到 `assets/<id>/media.<attempt-id>.mp4`，再原子写完整 `manifest.json`；视频名称从 `manifest.video.file` 读取，不硬编码。独立文件名可保留上次提交失败产生的孤立视频副本。
4. 持久化 `READY` 后发 `onSuccess`。任何前期失败保留信息/封面和尝试文件，通常回到 `AWAITING_MEDIA + error`；可在原任务重新绑定。

`manifest.json` 是视频提交的依据，不凭 MP4 文件或资产目录存在判定 READY。若最后日志写入失败则报 `PERSISTENCE_ERROR`，已提交 manifest 仍保留，下次启动恢复。数据目录只允许单个调度器拥有，绑定预检/排队/取消也纳入关闭等待。

### 原完整下载

流程保持不变：下载工具成功退出且报告合法最终 MP4 路径 → ffprobe → 规范化元数据与文件摘要 → 写 `manifest.json` → 整目录 rename → `completed` → 成功事件。不会要求旧任务补 `metadata.manifest.json`。

失败、超时、取消不删目录；抓取重试新建任务，绑定重试新建尝试目录。死 PID 锁 marker 不阻止恢复、不自动删除；PID 被复用时保守视为占用。损坏日志不会静默忽略，应先备份后人工修复。

这些措施提供明确提交边界，但不能承诺硬件损坏、文件系统不支持原子 rename 或突然断电时绝对不丢数据。重要素材需备份，数据根避免网络文件系统/同步冲突目录。

## 错误码

| 错误码 | 含义/动作 |
|---|---|
| `INVALID_URL` / `INVALID_PROXY` / `INVALID_OPTIONS` | 前置参数错误，未入队 |
| `INVALID_STATE` | 不在等待媒体状态、任务不存在或重复绑定 |
| `INVALID_MEDIA` | 本地文件后缀/路径/大小/类型不符，或复制时文件仍在变化 |
| `TOOL_NOT_FOUND` | 当前操作所需便携工具缺失或不可执行 |
| `SPAWN_FAILED` | 无法启动进程，检查安全软件/权限 |
| `NETWORK_ERROR` | 网络/代理连接异常；可重试 |
| `AUTH_REQUIRED` | 源站登录、年龄限制或验证码；不绕过 |
| `RATE_LIMITED` | 源站限流；可延时重试 |
| `UNAVAILABLE` | 视频不可用、区域限制或直播过滤 |
| `DOWNLOAD_FAILED` | 无法归类的 yt-dlp 失败；可重试 |
| `INVALID_OUTPUT` | 必需产物缺失、元数据/路径异常、ffprobe 校验失败（包括本地绑定） |
| `TIMEOUT` | 达到操作截止时间，终止进程树；保留文件 |
| `CANCELLED` | 用户取消，保留工作目录与已提交信息 |
| `INTERRUPTED` | 上次未正常收尾；抓取重试或重新绑定 |
| `PERSISTENCE_ERROR` | 文件系统/日志读写失败，素材不删除 |
| `STORE_LOCKED` | 其他实例占用相同数据根 |
| `SCHEDULER_CLOSED` | 关闭后不能新增任务或绑定 |

错误分类按 yt-dlp 提示启发式判断，不代表掌握源站内部状态；调度器不会无限重试。`retryable` 是建议而非禁止用户更换本地文件后重新绑定。

## 验收记录

执行：`npm run check`、`npm test`、`npm run verify:tools`、CLI `--help`。

- 37 项测试通过、0 跳过：包含原下载回归、真实 Windows 父/孙进程取消，以及元数据独立队列/超时、缺少 FFmpeg 的轻量运行、只需 ffprobe 的绑定、非法文件/重复绑定、取消预检竞争、重启与提交/日志故障恢复。
- 便携集成测试：FFmpeg 生成自制 fixture，本地带 Basic auth 的 HTTP 正向代理，真实 yt-dlp 载入预制 info JSON（仅替换源站提取步骤）；真实下载/合并/探测和封面字节校验。
- 同一集成测试验证元数据模式有封面请求、**零音视频请求**；真实 API 绑定、关闭后真实 CLI `--attach` 恢复任务，源文件不变且无需网络。
- 清空 PATH 运行便携工具；未访问 YouTube/TikTok 或依赖第三方账户。外部 SOCKS 服务、源站线上提取/耗时与用户代理尚未验收，不能将本地 fixture 通过表述为线上全可用。
- 未提供便携依赖时集成测试明确 skip。发布构建先执行 `verify:tools`，不能接受该测试被跳过。
