# OmniPost 模块边界与运行架构

## 已实现的数据流

```text
Electron renderer → context-isolated preload → authorized main IPC
  ├─ fetchMetadata → metadata + cover [AWAITING_MEDIA]
  │     ├─ AUTH_REQUIRED → isolated VerificationService → scoped cookies → new retry
  │     └─ attachLocalMedia → validated asset [READY]
  ├─ createManual → manual metadata + optional video / cover
  │     ├─ no video → AWAITING_MEDIA
  │     └─ verified MP4 → READY
  ├─ AIRewriter → four-platform rewritten.json (metadata sufficient)
  ├─ Processor → validated processed document + new MP4 (video required)
  └─ PublisherService → persistent creator portal → upload / prefill → HUMAN confirmation
```

- React + TailwindCSS + Lucide 使用集中式暖白 / Zinc token；默认日间，偏好本地持久化。
- renderer 无 Node、文件系统与任意 IPC 权限。每条 IPC 校验窗口、主 frame、来源和输入；远端验证页面没有 preload。
- 耗时任务不阻塞 renderer，状态来自结构化事件。服务错误脱敏，不向 UI 传原始 stderr、密钥或 Cookie。
- `assets/<id>` 目录存在不代表视频就绪。AI 可使用 metadata manifest；Processor 必须读取完整媒体 manifest；发布要求 READY/兼容 completed、目标平台已保存文案和校验过的加工成品。
- 手动补全采用不可变版本：创建新任务，继承旧素材的可信媒体路径并复制；不修改旧 manifest、文案或成品。视频通过文件句柄复制、源文件变化检查、ffprobe 与 SHA-256 校验。

## 模块职责

| 模块 | 责任 |
|---|---|
| `apps/desktop/src/main/index.ts` | 生命周期、授权 IPC、文件选择与服务编排 |
| `apps/desktop/src/main/studio.ts` | AI / FFmpeg 调度、加密设置、模型查询、文案编辑 |
| `apps/desktop/src/main/verification.ts` | 临时隔离验证窗口、域名限制、Cookie 保存 |
| `apps/desktop/src/preload` / `shared` | 最小权限类型化 API 与 Reply / event 契约 |
| `packages/core/src/fetcher` | 下载/元数据/手动队列、持久化、Cookie、媒体校验 |
| `packages/core/src/rewriter` | OpenAI / Anthropic 请求、模型查询、schema、逐平台原子保存 |
| `packages/core/src/processor` | FFmpeg 变速、裁剪、重采样、元数据清理与输出事务 |
| `packages/core/src/publisher` | 四平台配置矩阵、独立持久化浏览器、登录验证与上传预填 |

Fetcher、Rewriter、Processor 与 Publisher 不依赖 Electron，可通过离线 fixture / injected transport / launcher 单独验收。平台差异集中在 `publisher/platforms.ts`，浏览器生命周期与人工接管逻辑集中在 `publisher/publisher.ts`。

## 数据目录

开发默认 `.omnipost/`，打包后为 `<userData>/library/`；可通过 `OMNIPOST_DATA_DIR` 指向隔离 QA 库。

```text
<library>/
├─ jobs/                          持久化任务，不含 Cookie
├─ work/                          未提交 / 失败尝试，不覆盖已提交资产
├─ locks/                         调度器独占锁
├─ assets/<task-id>/               媒体、封面、metadata / media manifests
│  ├─ rewritten.json              四平台已保存文案
│  └─ processed/                  衍生成品及处理凭据
├─ cookies/{youtube,tiktok}.txt    明文 Netscape Cookie，仅供相应 fetcher 使用
├─ cookies/request-<uuid>.txt      单次下载 Cookie 副本，结束时清理
└─ profiles/
   ├─ accounts.json               上次验证状态，不含 Cookie
   └─ {douyin,bilibili,kuaishou,xiaohongshu}/
                                  每平台独立 Chromium userDataDir
```

桌面设置在 Electron userData（开发时 `<library>/.desktop/`）。API Key / 自定义 Headers / 代理凭据使用 safeStorage；不可用时仅保存在内存。Cookie 与浏览器 profile 本身不受此加密承诺保护，必须按敏感会话数据管理。当前每个平台一个账号目录，不宣称支持同平台多账号。

## 安全与人工接管边界

- 源站验证只允许 HTTPS 平台域名，禁止子窗口、下载、Node、权限请求；用户亲自完成挑战并回到工作台确认保存。Cookie 按域名、有效期与格式过滤，下载每次独立快照，不泄露到素材/事件。
- AI 的旧凭据不会隐式发往新 origin；模型请求同样检查。自定义 Headers 禁止覆盖路由、认证与传输控制头。System Prompt 微调保留输出 schema 约束。
- 平台扫码登录优先匹配有效核心 Cookie（B站需 DedeUserID + SESSDATA，抖音 sessionid，快手 passToken，小红书 web_session），不等待导航或 DOM 完成。兼容会话名需官方创作者路由与已登录 DOM 共同佐证，URL 本身不代表登录。磁盘目录或旧状态不代表当前登录有效；发布前重新检查，超时/关闭会释放窗口并通知界面。
- 只操作官方创作者页面及受信任 frame；离站页面不注入视频或文案。同平台互斥，不同平台独立；关闭应用等待浏览器与进行中的操作退出。
- **没有最终发布点击**。上传预填不等于上传完成或发布成功；话题绑定、封面、分区、版权声明和最终提交均由本人检查。页面改版时显示手动兜底，不猜测提交按钮。
- 不实现逆向签名上传接口、验证码破解、DRM/付费限制绕过或反检测脚本。素材权利与平台规则仍是前提；轻量加工不保证规避重复内容检测。

## 验收与后续工作

离线测试验证协议、生命周期、凭据隔离、手动素材恢复与四平台 mock 预填（禁止最终提交）；真实本地 FFmpeg 验证加工输出。桌面 QA 使用独立数据目录。四个平台的真实账号登录及完整线上预填仍需逐平台人工验收，选择器应随官方页面调整维护。安装与操作说明见 [upgrades.md](upgrades.md)。
