# 架构与渐进交付

## 边界

```text
Electron 主进程 / 后续独立 worker
          │ 类型化 IPC（白名单命令/事件）
          ▼
DownloadScheduler → Fetcher
                      ├─ fetchMetadata → metadata + cover [AWAITING_MEDIA]
                      │                        ├─ AIRewriter → text JSON
                      │                        └─ attachLocalMedia → asset [READY]
                      └─ enqueue → full asset [completed，兼容旧流程]
                                          │
                                          └─ Processor → processed asset
                                                              │
                                              text JSON ──────┤
                                                              ▼
                                                   Publisher → receipts
```

- 渲染进程采用 React + TailwindCSS + Lucide，默认暗色。Node integration 关闭，context isolation 开启。上述 UI/IPC 尚未实现。
- 本轮核心不依赖 Electron，可通过 CLI 与离线 fixture 独立验收。
- 耗时/网络任务不得阻塞 renderer；前端仅订阅结构化状态，不解析子进程原始输出。
- `assets/<id>` 可以先只有元数据/封面：AIRewriter 可消费 `metadata.manifest.json`，不等待视频。Processor/Publisher 必须读取完整 `manifest.json`，不能根据目录存在推断媒体就绪。每个后续阶段拥有自己的输出和日志，发布失败不能删除输入。

## 未来目录职责（不创建空代码）

| 目录 | 责任 |
|---|---|
| `apps/desktop/electron` | 应用生命周期、IPC、系统托盘、配置和凭据保管、资源路径 |
| `apps/desktop/renderer` | 粘贴链接、任务看板、素材预览、账号卡片、代理/AI 设置 |
| `packages/core/src/processor` | 独立 FFmpeg 调用、进度与超时、变速/裁剪/重采样/元数据清理 |
| `packages/core/src/rewriter` | OpenAI 兼容 BaseURL/模型、平台提示词、输出 schema、文案落盘 |
| `packages/core/src/publisher` | 协调器、每平台 Playwright 适配器、人工接管、发布回执 |
| `resources/bin/<platform>-<arch>` | 可执行依赖，必须在 Electron extraResources 中解包部署 |
| `resources/browser` | 后续由构建流程准备 Playwright 浏览器；不用终端用户手动安装 |
| `resources/stealth` | 后续审查后放置浏览器初始化脚本；不等同于验证码绕过 |

## 运行数据（规划）

```text
<userData>/
├─ config/                              非敏感设置；密钥使用系统安全存储
├─ downloads/                           本轮 dataDirectory
│  ├─ jobs/
│  ├─ work/
│  ├─ assets/
│  └─ locks/
├─ processed/<source-id>/<revision>/     后续媒体衍生物
├─ rewrites/<source-id>/<revision>/      后续每平台文案与标签
├─ browser-profiles/<platform>/<account-id>/
│                                        每账号独立 userDataDir
└─ publications/<job-id>/                发布状态、回执、必要的诊断截图
```

账号采用内部 UUID，不将昵称直接用作路径。不同平台/账号不得复用 Cookie、LocalStorage 或浏览器用户目录。登录有效期由平台决定，不能保证扫码永久有效。

## 分发红线（后续实现时遵循）

- 只使用 Playwright 驱动官方创作者中心真实网页，不实现逆向签名 HTTP 上传接口。
- 上传、等待处理、填文案、话题、封面、提交分别具有超时与明确事件；视频上传 100% 不等于发布成功。
- 滑块/短信/登录验证通过 `onCaptcha` 等专属事件暂停并显式请求用户；浏览器置前后由用户完成，确认状态恢复后才继续。
- 本轮 `onError(AUTH_REQUIRED)` 是下载源站访问受限，不冒充发布 HITL，也不会开浏览器假装已经接管。
- 适配器细节逐个平台验收；提交前给予用户内容与目标账号确认，避免重复发布。发布回执与素材生命周期分离。

## 增量里程碑

1. **已交付 Fetcher**：便携工具、代理、独立元数据/媒体队列、手动绑定 MP4、可靠落盘、CLI 和测试。
2. **Processor**：在自制测试片上验证 1.02× 音视频同步、1% 裁剪（明确按总尺寸还是单边定义）、音频重采样和元数据删除，不覆盖下载资产。
3. **最小桌面面板**：下载/处理队列，取消重试、代理设置、打开素材目录，接入现有类型化事件。
4. **AIRewriter**：自定义 BaseURL/模型、平台结构化提示词、超时重试，生成结果先原子落盘。
5. **单平台 Publisher**：先完成一个创作者中心的登录、上传、填表、人工验证与结果确认，再扩展平台。

轻量编辑不保证规避平台重复内容检测；素材权利、内容价值和平台规则仍是发布前提。
