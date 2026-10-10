# AIRewriter：本地化、多平台改写与可靠落盘

## 设计与文件职责

Rewriter 不依赖 Electron、便携二进制或第三方 SDK，使用 Node 22 内置 `fetch`。不改 Fetcher 状态机、任务日志、视频或源元数据。只要 `assets/<taskId>` 已提交信息/封面（包括 `AWAITING_MEDIA`），即可先改写。

```text
packages/core/src/rewriter/
├─ types.ts       平台、输入/输出、配置、事件与错误契约
├─ errors.ts      脱敏 RewriterError，不复用下载错误码类型
├─ metadata.ts    从原始 info JSON 提取有界文本白名单
├─ prompts.ts     四平台风格、事实约束、源文本与指令隔离
├─ parser.ts      Markdown/解释文本容错与结构校验
├─ client.ts      Chat Completions 兼容 HTTP、超时、取消、响应大小限制
├─ store.ts       任务级写锁、源摘要、已有结果检查、原子合并提交
└─ rewriter.ts    单平台接口、多平台编排、逐平台落盘、事件
```

新增出口统一从 `packages/core/src/index.ts` 导出；CLI 为 `tools/rewrite.ts`，测试为 `tests/rewriter.test.mjs`。

## 公共 API

### 任务改写

```ts
import { AIRewriter } from './dist/packages/core/src/index.js';

const rewriter = new AIRewriter({
  dataDirectory: '/absolute/path/to/.omnipost', // 与 Fetcher 相同
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.OMNIPOST_LLM_API_KEY ?? '',
  model: 'deepseek-chat',
  temperature: 0.7,
  timeoutMs: 60_000,
  onProgress: (event) => console.log(event.platform, event.phase),
  onSuccess: (taskId, copy) => console.log(taskId, copy.platform),
  onError: (taskId, platform, error) => console.error(taskId, platform, error.code),
});

// targetPlatforms 仅接受完整平台名，CLI 才接受 xhs/bili/dy/ks 别名。
const result = await rewriter.rewriteTask(taskId, ['xiaohongshu', 'bilibili'], {
  temperature: 0.6, // 本次覆盖，不修改实例默认配置
});
if (result.state === 'completed') console.log(result.outputFile);
else console.error(result.state, result.errors); // partial / failed / cancelled
```

`rewriteTask(taskId, targetPlatforms, options?)`：按去重后的平台顺序串行调用，**每个平台成功后立即落盘**，再处理下一个；不同任务可并行调用，同一任务并发报 `STORE_LOCKED`。实例不维持常驻资源，无需 `close()`。

返回 `RewriteTaskResult`：
- `completed`：本次所有请求平台都成功并提交。
- `partial`：本次部分成功、部分模型/API 失败。
- `failed`：本次无新成功结果；旧文案仍可能存在。
- `cancelled`：用户取消，保留已经提交的结果。
- `document` / `outputFile`：仅存在可用已提交结果时返回；`document.platforms` 可能包含以前生成、此次未请求的平台。
- `errors`：本次失败平台的脱敏错误，不把提供方原始错误写进资产。取消后未发出的剩余平台也记录 `CANCELLED`，不会新增 HTTP 请求。

前置配置/任务错误、已有资产损坏、源信息变化和存储失败 **reject `RewriterError`**；单平台 HTTP/输出错误记录到 `result.errors` 后继续。存储失败立即停止后续付费请求；已经完成的提交仍保留。

重新调用会重新生成所选平台（可能再次计费），成功后替换该平台，失败保留其旧成功结果；未选平台不会消失。没有隐式付费重试，也不会悄悄换模型或切换提供商。

### 单平台独立改写

```ts
import { rewriteSinglePlatform } from './dist/packages/core/src/index.js';

const copy = await rewriteSinglePlatform({
  title: 'Small balcony herb garden',
  description: 'Grow herbs in limited space.',
  tags: ['herbs'],
  subtitles: { en: [{ text: 'Basil needs sunlight.' }] },
}, 'douyin', {
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OMNIPOST_LLM_API_KEY ?? '',
  model: 'gpt-4o-mini',
});
console.log(copy.title, copy.hook, copy.tags);
```

也可使用实例方法 `rewriter.rewriteSinglePlatform(inputMeta, platform, options?)` 复用配置。单平台调用**不做文件 IO**，失败直接 reject。构造器第二参数是测试用 `LLMTransport` 注入点，生产调用应省略。

### 配置

| 字段 | 默认/规则 |
|---|---|
| `baseURL` | `https://api.deepseek.com/v1`；填写 API 根，不包含 `/chat/completions`，支持自定义路径 |
| `apiKey` | DeepSeek/OpenAI 官方域名要求非空；本地兼容服务可省略；仅在内存配置中保存并用作 Bearer 请求头 |
| `model` | 默认 `deepseek-chat`；`api.openai.com` 默认 `gpt-4o-mini`；自建代理/本地服务请显式填写模型 |
| `temperature` | 默认 0.7，范围 0–2 |
| `timeoutMs` | 默认 60,000，范围 1–600,000；每平台 HTTP 请求及完整响应体的共同截止时间 |
| `maxTokens` | 默认 2048，范围 128–8192；发送为 `max_tokens` |
| `jsonMode` | 默认 true，发送 `response_format: { type: 'json_object' }`；不支持的兼容服务可手动关闭 |
| `signal` | 可选 AbortSignal；中断请求，忽略可能含秘密的自定义 abort reason |

远端要求 HTTPS；HTTP 仅允许 `localhost`、127.x.x.x、`[::1]`。URL 不接受 userinfo、query、fragment，不跟随重定向以避免将请求转发给其他提供商。自建局域网服务可使用 HTTPS 或通过本地端口转发接入。本模块面向本机用户配置，不是公共多租户任意 URL 代理。

请求协议为 `POST <baseURL>/chat/completions`，非流式，消息为 `system` + `user`。不依赖 Responses API 或某提供商 SDK。部分新模型不接受 temperature/max_tokens/json mode，需使用支持该 Chat Completions 子集的模型；不承诺任何任意“兼容端点”都可直接使用。

## Prompt 与输出约束

| 平台 | 风格与必需字段 |
|---|---|
| `xiaohongshu` | 痛点｜收获二段式标题，丰富 Emoji，真实种草要点与互动；3–5 个去重话题，程序统一追加到 body 文末 |
| `bilibili` | 吸引力标题，恰当的梗/好奇心，核心摘要；`category` 推荐中文分区、标签 |
| `douyin` | `hook` 黄金 3 秒引导，极简标题，简短看点和互动、相关话题 |
| `kuaishou` | `hook` 黄金 3 秒引导，极简标题，接地气、实用与真实感、相关话题 |

统一输出为 `title/body/tags`；B站另需 `category`，抖音/快手另需 `hook`。本模块设定编辑长度上限：标题小红书40/B站80/抖音快手30个 Unicode 码点，正文4000，hook/category 80，标签单项30。它们不是对各平台最新发布规则的认证；发布前仍需平台适配器复核。

“热门”指相关且有传播潜力的表达，**未调用实时热榜**；分区是建议名称，不是平台 category ID。Prompt 要求事实忠实，不编造体验/功效/统计，不声称看过视频。源文本单独 JSON 编码，指令要求将其视为不可信数据；这不能绝对保证模型抵御所有提示注入，发布前仍需人工审稿。

解析允许纯 JSON、Markdown `json` 代码块、对象外的解释文字，以及字符串中的花括号。只接受一个结构有效对象，不执行模型代码，不用正则强修坏引号，不接受多个 JSON 对象/代码块、截断输出、拒绝回答、缺必需字段或非法标签。去除标签前导 `#` 并去重；不伪造缺失正文、hook 或分区。

## 本地输入与资产提交

1. 校验 UUID、真实任务目录、`metadata.manifest.json` 或旧下载 `manifest.json` 提交凭据；不读取 `work/`。改写锁与 Fetcher 全局锁独立，改写与媒体绑定可共存。
2. 从 `media.info.json`（最多32 MiB）提取原标题、描述、标签、语言、字幕可用语言及已有文本。标题/描述/字幕分别最多500/12,000/16,000字符，标签最多30项，避免无限上下文。
3. **不上传整份 info JSON**：不发送 `formats`、签名媒体地址、Cookie 等附加字段；字幕 URL 仅表示可用性，不访问、不发送。支持 `transcript` 字符串和 `subtitles` / `automatic_captions` 的 `text` / `data` 字符串；只有 URL 时不虚构字幕。
4. 校验已有 `rewritten.json`，保留其他平台。损坏时拒绝覆盖；源文件 SHA-256 与已有改写不一致时返回 `SOURCE_CHANGED`，要求先备份排查，避免新旧来源混合。
5. 每次成功后再次校验源摘要，使用既有 `atomicJson` 的同目录唯一临时文件 + fsync + rename 写 `assets/<id>/rewritten.json`，然后发成功事件。取消若已越过提交边界，不回滚已提交结果。
6. 使用 `assets/<id>/.rewrite-locks/<pid>-<uuid>.lock` 排除同任务跨实例/进程写入；异常退出的死 PID marker 保留但不阻塞。PID 重用保守视为占用；确认进程已退出后才能人工处理。

```json
{
  "schemaVersion": 1,
  "taskId": "<任务 UUID>",
  "updatedAt": "2026-10-10T00:00:00.000Z",
  "source": { "file": "media.info.json", "sha256": "<源文件 SHA-256>" },
  "platforms": {
    "douyin": {
      "platform": "douyin",
      "model": "deepseek-chat",
      "generatedAt": "2026-10-10T00:00:00.000Z",
      "title": "阳台香草角",
      "body": "小空间也有种植乐趣。你会选什么香草？",
      "tags": ["阳台种植", "生活"],
      "hook": "你的阳台，还能多一个香草角！"
    }
  }
}
```

原始视频、封面、元数据和 Fetcher 的任务状态均不变。原子写入复用项目现有文件系统保证，并不替代备份；数据根应为本地私有目录，避免同步冲突/不支持原子 rename 的文件系统。

## CLI

```powershell
npm run build
# 假定已通过 fetch --info-only 得到 taskId
$env:OMNIPOST_LLM_API_KEY = '<从安全配置注入>'
npm run rewrite -- '<taskId>' --platform xhs,bili

# OpenAI：显式选择提供商，不能只更换 Key
npm run rewrite -- '<taskId>' --platform dy,ks --base-url 'https://api.openai.com/v1' --model 'gpt-4o-mini'
Remove-Item Env:OMNIPOST_LLM_API_KEY

# 已运行且已安装模型的本地 Ollama，模型名称需换成实际名称
npm run rewrite -- '<taskId>' --platform xhs,bili --base-url 'http://localhost:11434/v1' --model '<本机模型名>'
```

本模块不启动 Ollama、不下载模型。使用 `--data` 时须和 Fetcher 的数据根一致。`--api-key` 可用但更推荐专用环境变量，避免命令历史；环境变量不等于操作系统级秘密隔离。

环境变量仅读取 `OMNIPOST_LLM_API_KEY`、`OMNIPOST_LLM_BASE_URL`、`OMNIPOST_LLM_MODEL`；**不隐式继承 `OPENAI_API_KEY`**，避免将其他工具的密钥误发到当前提供商。优先级为 CLI 显式参数 > OmniPost 专用环境变量 > 核心默认值。核心 API 不自动读取环境变量。

`--platform` 支持 `xhs/bili/dy/ks` 或四个完整名称，逗号分隔；未知名称报错。`--no-json-mode` 支持旧兼容端点。输出逐行结构化进度及最终回执，不打印原始 Prompt 或 API Key。全部成功退出0，部分/全部失败退出1，Ctrl+C 退出130。

## 错误与事件

- 配置/输入：`INVALID_OPTIONS`、`INVALID_PLATFORM`、`INVALID_METADATA`、`TASK_NOT_FOUND`、`ASSET_NOT_READY`。
- 存储/并发：`STORE_LOCKED`、`SOURCE_CHANGED`、`CORRUPT_OUTPUT`、`PERSISTENCE_ERROR`。
- 请求/响应：`AUTH_ERROR`（401/403）、`RATE_LIMITED`（429）、`API_ERROR`（其他非2xx，可附HTTP status）、`NETWORK_ERROR`、`INVALID_RESPONSE`、`TIMEOUT`、`CANCELLED`。

`onProgress` 的 `started/saved/failed` 为平台步骤，不是 token 百分比；`completed` 为本次已收尾平台数。`onSuccess` 仅在任务结果落盘后触发；`onError` 通知单个平台请求/输出失败，前置/存储错误通过 Promise reject。单平台无落盘接口不触发这些任务级事件。回调接收副本，异常及异步 rejection 不影响持久化。

## 验收边界

本轮新增23项离线 Rewriter 测试，连同原有37项共60项，全部通过、0跳过：平台风格、文本白名单、JSON容错、协议参数、旧/新资产兼容、逐平台提交、失败保留旧结果、写锁、配置覆盖、响应体超时、取消、存储失败、源变更、真实 CLI + 本地 Mock HTTP、密钥隔离与失败退出码。

测试不需要 API Key、付费调用或外网。没有对真实 DeepSeek/OpenAI/Ollama 部署进行在线验收，也不代表模型文案质量已达到发布标准；使用时需审查事实、权利、平台调性及最终账号发布规则。


## Studio 扩展

- `AIRewriter.rewriteMultiPlatform(manifest, platforms, options?)`：以 manifest.taskId 定位**已提交**元数据，其他传入的路径/文本不作为可信源。另提供同名独立函数，第三参数包含 dataDirectory。
- `readTask(taskId)`：读取并校验已落盘文档。
- `saveCopy(taskId, platform, copy, expectedUpdatedAt)`：锁内验证并原子保存人工微调，拒绝旧版本覆盖。保留模型、生成时间、provider 用量，新增 editedAt。
- `PlatformRewrite.usage`：可选的 `promptTokens / completionTokens / totalTokens`，只记录 API 实际返回的合法整数，不估算。
- `.operations/<id>.json`：每次尝试先记录 started，然后写成功或失败；截断/无效输出也保留已返回的 usage，意外中断保留未完成标记。旧项目无操作记录时不回填虚构历史。
- 桌面端 `onProgress` 显示平台与完成数量，不模拟 token 流；实际内容仍在逐平台提交后保留。
