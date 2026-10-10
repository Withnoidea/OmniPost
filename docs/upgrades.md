# 核心升级使用指南

## 运行准备

```powershell
npm install
npm run setup:browser # 每台机器首次使用发布助手时安装 Playwright Chromium
npm run dev
```

下载/加工继续使用 `resources/bin/` 便携工具（准备方式见 README）。Chromium 默认安装到 Playwright 的用户缓存目录，尚未打包进可分发安装器；发布服务启动失败会给出安装提示。不要同时使用同一个数据目录运行 CLI 与桌面调度器。

## 1. 源站需要人工验证

1. YouTube / TikTok 解析返回 `AUTH_REQUIRED`，任务显示「需要人工验证」。
2. 点击「打开验证窗口」，在临时隔离窗口内自行完成登录、滑块或其他挑战。OmniPost 不自动破解验证。
3. 返回工作台点击「验证完成，保存并重试」。保存相应域名 Cookie，创建新重试任务，原失败记录保留。
4. 后续 yt-dlp 自动携带平台 Cookie。验证关闭/加载失败可重新打开；仍然受限时可再次验证或手动录入，不保证所有源站风控都可解除。

Cookie 存在 `<library>/cookies/{youtube,tiktok}.txt`。它们是 **明文敏感会话凭据**（Netscape / yt-dlp 互操作格式），不与 AI 或发布平台共享。每次抓取使用独立工作副本并清理。不要将 Cookie、profile 或整个素材库上传到 Git、网盘或诊断附件。隔离验证窗口不是发布账号浏览器，两者不复用会话。

## 2. 无链接创建与解析失败兜底

- 点击工作台「手动创建」，或任意失败任务下的「手动补全当前素材」。
- 填写标题、简介、Tags（逗号/换行分隔）及作者；可拖入 MP4 视频与 JPG / PNG 封面，也可使用文件选择器。
- 不提供封面时生成 PNG 占位图；不提供视频时先保存为 `AWAITING_MEDIA`，此时可先改写文案，之后挂载 MP4。
- 附带视频时先复制并校验 MP4 容器、视频流与正时长，再提交 `READY`，立即可执行 AI 改写与 FFmpeg 加工。文件名后缀不能替代校验；损坏/不合规输入不会假装成功。
- 补全已有任务 **另存为新任务**，保留旧任务、媒体、文案与成品。可沿用旧视频/封面，也可替换；原本地文件不会被移动、覆盖或删除。新任务的改写和加工需重新执行，避免元数据改变后误用旧成品。

## 3. AI 协议与模型设置

全局设置 → AI 模型连接：

| 设置 | 行为 |
|---|---|
| OpenAI 兼容协议 | `/chat/completions`，适用于 DeepSeek、OpenAI、OneAPI、Ollama 等兼容服务 |
| Anthropic 原生协议 | `/messages`，`x-api-key` + `anthropic-version`，独立 system / user 消息 |
| Base URL | 填写 API 根，如 `https://api.anthropic.com` 或网关 `https://gateway.example/custom/v1`；无路径补 `/v1`，自定义路径保留 |
| 测试连接并获取模型 | GET API 根下的 `/models`（标准 `/v1/models`），返回去重列表；不调用收费改写 |
| 模型（可自定义） | 从列表选择或填写任意服务实际支持的模型名；模型列表不可用不阻断手工配置 |
| 高级 Headers | JSON 字符串键值对象，例如 `{"X-Workspace":"creator"}`；禁止 Host / Authorization / Cookie / x-api-key 等危险覆盖 |
| System Prompt 微调 | 编辑风格偏好，追加到四平台结构化输出规则，而不是移除规则 |

只允许 HTTPS，loopback 可使用 HTTP。不要把完整 `/messages`、`/models` 或 `/chat/completions` 请求地址填作 Base URL。模型列表成功只说明该接口可达/返回了模型，不保证该模型一定支持结构化改写或有调用额度。平台文案只发送必要文字，不发送视频、Cookie 或浏览器账号。

API Key 与自定义 Headers 使用 Electron safeStorage 加密；加密不可用时仅本次会话保留，不明文写盘。UI 不回显已有密钥/Headers；留空保留，Headers 输入 `{}` 清除。更换服务 origin 清除未显式替换的旧 Key 与 Headers，测试未保存连接时同样不跨域转发旧凭据。

## 4. 四平台账号与发布预填

1. 监控中心 → 平台账号，点击抖音 / B站 / 快手 / 小红书的「连接 / 登录」。
2. 专属 Chromium 打开官方创作者入口，用户扫码登录。服务检测有效会话 Cookie 与已登录页面标记，成功后自动关闭登录窗口，UI 显示 Connected。
3. 每个平台独立持久化目录：`<library>/profiles/{douyin,bilibili,kuaishou,xiaohongshu}`。重启可复用；Connected 表示上次验证结果，发布前会重新检查，失效需重新登录。
4. 为 READY 素材保存目标平台文案，并完成 FFmpeg 加工。发布读取经过校验的成品 MP4，不误传原片；未保存草稿不用于发布。
5. 点击「发布到平台」，选择相应平台；浏览器选择成品文件，填写标题、简介、钩子与 `#标签` 文本。
6. **在浏览器中检查上传进度、真实话题绑定、封面、分区、版权声明与账号，亲自点击最终发布。** 应用不会点击最终提交，不将「文件已选择」计作上传成功或发布成功。

平台页面变化或字段未匹配时会给出警告并保留窗口，供手动填入；预填期间不能同时重开同平台目录。可在账号卡片关闭窗口；应用退出也会清理浏览器。只有官方域名页面/frame 才允许自动注入文件或文字。当前每平台一个独立账号，不实现同平台账号轮换。

## 验收范围

```powershell
npm run typecheck
npm test
npm run desktop:test
npm run desktop:build
```

- 离线 mock 覆盖两个 AI 协议、模型获取、错误脱敏、加密/跨 origin 隔离、Cookie 验证保存/重试、手动元数据及媒体恢复、四平台持久化登录与预填、取消/超时/并发/关闭，以及绝不触碰最终发布按钮。
- 自制视频验证手动 READY → 四平台 mock 改写 → **真实便携 FFmpeg** 完整链路。
- 桌面在隔离 QA 库验证日夜主题、手动拖入与模型列表交互，未使用生产库或真实账号。
- 额外用真实 Chromium + 全请求本地拦截页面验证四平台 profile 重启后 Cookie 复用、视频文件选择、文本预填和不点击最终发布；这不等同于真实平台验收。
- 尚未使用用户真实扫码凭据完成四平台线上发布验收；真实页面选择器、登录挑战、上传处理时间等需逐平台复核。代码适配矩阵是可维护的最佳努力预填，不承诺无人值守发布。
