# OmniPost Overnight 交付记录

日期：2026-10-10（Asia/Singapore）。所有实现已写入项目，未创建提交，未覆盖现有用户资产。

## 交付清单

- [x] Electron + Vite + React / TypeScript + Tailwind + Lucide，Windows 无边框暖灰桌面窗口。
- [x] Studio / Analytics 双主页 + 统一 Settings，按钮真实可交互。
- [x] Fetcher 元数据与下载解耦，代理、元数据/封面、原生 MP4 选择/拖入、任务队列、重启恢复。
- [x] 四平台 Prompt、OpenAI-compatible 自定义服务、Markdown/JSON 容错、超时/取消/脱敏错误。
- [x] `rewriteMultiPlatform(manifest, platforms, options)`，逐平台原子落盘，编辑保存/版本检查/复制。
- [x] 真实便携 FFmpeg 裁剪/变速/调色/锐化/音轨重采样/源元数据清理，实时 stderr 进度。
- [x] `processed.mp4` 导出、可恢复版本化提交、`PROCESSED_READY`；保持 Fetcher 状态机不变。
- [x] 本地持久化任务/字节/AI 调用与真实返回 Token/耗时指标、7 日趋势与平台环图。
- [x] 四平台卡片明确「待配置账号 / Pending Profile」，不伪造发布或流量。
- [x] 系统加密保存 Key，读取设置不返回秘密，服务 origin 改变默认清除旧 Key。
- [x] 原有37项 Fetcher 回归持续通过；目前69项 Core +10项 Desktop 测试通过。
- [x] `npm run typecheck` 整仓通过；`npm run desktop:build` 通过。
- [x] Windows 实窗端到端验收：原生拖入、四平台 Mock、编辑/复制、真实 FFmpeg、Analytics、加密与失败/取消恢复。
- [x] 最终根目录 `npm run dev` 干净启动确认，普通桌面窗口已保留运行（03:44 SGT，PID 43744，未启用调试端口）。

## 启动与使用

```powershell
npm install           # 已安装依赖无需重复
npm run dev           # 根目录，直接唤起桌面端；React HMR，main/preload watch
```

1. Settings 配置 Base URL、模型及 Key。DeepSeek 默认 `https://api.deepseek.com/v1` / `deepseek-chat`；OpenAI `https://api.openai.com/v1` / `gpt-4o-mini`；Ollama 例如 `http://127.0.0.1:11434/v1` / 已下载的本地模型。
2. 解析 YouTube/TikTok 链接。默认测试链接可用 `https://www.youtube.com/watch?v=jNQXAC9IVRw`，但源站有可能要求登录/反机器人验证；本机此前实测返回 `AUTH_REQUIRED`，**未声称该在线链接下载成功**。
3. 把你拥有使用权、下载完整的 `.mp4` 拖入任务，或点击浏览。
4. 选择平台生成文案，可编辑后「保存微调」再复制。元数据到手即可进行，不需要等待视频。
5. 挂载后开启智能处理，完成可在素材目录拿到 `processed.mp4`。原片保留，微调不保证绕过平台重复识别。
6. Analytics 查看本地记录。代理只用于 Fetcher；API 调用不使用该代理。未配置真实发布账号，发布入口保持不可用。

默认库 `.omnipost`；不要让另一 CLI Scheduler 同时独占该库。便携工具已在 `resources/bin/win32-x64`，无需设置 PATH。开发依赖 Node>=22.12；本次未制作 EXE 安装包。

## 验收证据

- Core：`tests/*.test.mjs`，69项通过，包括实际 FFmpeg 与本地 HTTP Mock。
- Desktop：`apps/desktop/tests/desktop.test.mjs`，10项通过。
- [实窗 Studio](artifacts/desktop/studio-initial.png)
- [AI 编辑与 PROCESSED_READY](artifacts/desktop/studio-ai-processed.png)
- [Analytics](artifacts/desktop/studio-analytics.png)
- [统一设置](artifacts/desktop/studio-settings.png)
- [CDP + 真实 IPC 断言记录](artifacts/desktop/studio-e2e.json)
- [完整重启后的 Studio](artifacts/desktop/studio-restart.png)
- [普通库启动与 CSS HMR 验证](artifacts/desktop/dev-smoke.json)
- [最终正常窗口运行记录](artifacts/desktop/final-running.json)
- 回归与构建日志在 `artifacts/desktop/final-*.log`（本地生成，artifacts 不进 Git）。

实窗验证过程中发现两条同时读 library 的请求会争夺 Processor 读锁，已在主进程按任务合并读取；10个同时读取通过。离线 Mock 的429和取消保持旧文案不变，尝试次数增加但 Token 不虚构；Key 磁盘文件不包含明文，重启后仍可调用。

最终收尾：最新构建经完整进程重启，人工编辑、四平台文案及处理结果恢复；根目录开发命令的真实 IPC 与 CSS HMR（不重载页面）已验证。普通库未注入 Mock Key/地址，原有在线解析失败记录保留；最终启动 stderr 为空。验收用 Mock 已停止。Windows 曾拒绝仅测试用的9224调试端口，改用9223完成验收；交付窗口不带任何调试端口。

## 离线 Mock 与复现

生产程序不注入样例、不默认连接 Mock。以下显式测试工具只操作 `artifacts/desktop/qa-*`：

```powershell
npm run build
npm run desktop:build
node tools/desktop-qa-seed.mjs      # 自制 FFmpeg 测试图视频，2个元数据任务
node tools/desktop-qa-llm.mjs       # 独立终端；仅监听127.0.0.1，地址写入qa-llm.json

# 另一个 PowerShell，先关闭普通窗口
$f = Get-Content -Encoding UTF8 artifacts/desktop/qa-fixture.json | ConvertFrom-Json
$env:OMNIPOST_DATA_DIR = $f.dataDirectory
.\node_modules\electron\dist\electron.exe apps/desktop --remote-debugging-port=9223
```

在 QA 窗口 Settings 中填 `qa-llm.json` 的 baseURL、模型 `qa-local` 和测试 Key `qa-offline-secret`。先执行 `node tools/desktop-qa-drag.mjs`（原生 CDP 文件拖入，断言2个 READY）；选择最新任务，点击「改写全部平台」、保存一次人工编辑，开启 FFmpeg。随后 `node tools/desktop-qa-studio.mjs` 验证库读取、原素材、4平台产物、处理输出、凭据隔离、429/取消与统计。

Mock 正常响应示例（仅测试用量，不代表付费模型实际消耗）：

```json
{
  "choices": [{"finish_reason":"stop","message":{"content":"```json\n{\"title\":\"一段视频的本地旅程\",\"body\":\"原片保留，处理结果独立保存。\",\"tags\":[\"素材管理\"],\"hook\":\"你的视频素材存好了吗？\"}\n```"}}],
  "usage":{"prompt_tokens":180,"completion_tokens":80,"total_tokens":260}
}
```

模型 `qa-fail` 返回429，`qa-slow` 延迟10秒便于测试取消。用完关闭测试窗口/Mock，并清除 `OMNIPOST_DATA_DIR` 后正常 `npm run dev`，不要把测试 Key 写入普通库。

## 边界与后续

- 此次交付不包含账号扫码、Playwright 发布、EXE 打包或真实平台流量拉取，绝不把预留插槽表述为已实现。
- 源元数据清理经过 ffprobe 校验无源 title/comment、Lavf/Lavc 标记；容器必需技术字段仍存在。SEI过滤、8bit H.264输出不适合要求原始 HDR/字幕保真的素材。
- 成功处理使用「版本文件 + 原子指针 + 可恢复导出」而非声称两个文件同时原子替换；历史版本保留，占用额外磁盘。
- AI草稿切页/平台保留但不自动落盘，关闭前请显式保存；设置的AI/处理组与代理组各自原子保存，不提供跨文件全局事务。
- 指标是本地尝试/资产记录，不是精确网络线流量、API账单或真实发布数据；没有 usage 的调用显示为未返回用量。
