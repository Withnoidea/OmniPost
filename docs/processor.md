# FFmpeg Processor

## 核心接口

```ts
import { MediaProcessor, resolvePortableTools } from './packages/core/src/index.js';
const processor = new MediaProcessor({
  dataDirectory: '/absolute/library',
  tools: resolvePortableTools('/absolute/resources'),
  onProgress: event => console.log(event.phase, event.percent),
});
const ready = await processor.processTask(taskId, {
  speed: 1.02, cropPercent: 1, contrast: 1.02, sharpen: 0.15,
  timeoutMs: 30 * 60_000, signal: controller.signal,
});
console.log(ready.state); // PROCESSED_READY
const restored = await processor.readTask(taskId);
```

读取 Fetcher 已提交的 `manifest.json`，检查输入文件真实路径、非符号链接、体积和 SHA256。不会仅凭扩展名或目录存在假定视频就绪。

## 算子

- 裁剪总宽高各 1%，向下取偶数以满足 H.264/yuv420p。默认例如 1280×720 → 1266×712。
- `eq=contrast=1.02`、`unsharp=5:5:0.15:5:5:0`。
- `setpts=(PTS-STARTPTS)/1.02`；若有音频，`asetpts=PTS-STARTPTS,atempo=1.02`，AAC 48 kHz。无音轨亦能完成。
- H.264 CRF20 / veryfast / yuv420p，CPU 线程2，MP4 faststart。
- `-map_metadata -1 -map_chapters -1`，清空 format/stream encoder，bitexact 抑制 FFmpeg 标记，H.264 SEI 过滤去除 x264 标识。只选首个视频和可选首个音轨，不携带原字幕/章节/附件。
- 容器必需的 codec、brand、时长等技术字段仍存在；不声称输出没有任何技术元数据，也不保证规避重复识别。不是无损或 HDR 保真转码。用户应仅处理有权使用的内容。

## 输出与事务

```text
assets/<taskId>/
├── 原始视频 / metadata.json / media.info.json / 原 manifest  # 不变
├── processed-<operationId>.mp4       # 不可变、校验后的权威产物
├── processed.json                   # 原子指针，state=PROCESSED_READY
├── processed.mp4                    # 便于使用的可恢复导出副本
└── .operations/<operationId>.json    # started / succeeded / failed、耗时
```

不能把「视频 rename」和「JSON rename」虚构成跨文件原子操作，因此先生成唯一版本文件并 fsync/hash，再原子提交 `processed.json`，最后从它物化 `processed.mp4`。如果崩溃恰好发生在两者之间，`readTask` 校验权威版本并修复导出。视频编码/校验失败不会替换上一份产物。历史版本暂保留以保护资产，占用额外磁盘；不实现自动清理。

`PROCESSED_READY` 属于独立 Processor 文档，不改变 Fetcher 的终态及恢复规则。原始资产和改写内容始终解耦。

进度由 FFmpeg `-progress pipe:2` 的 stderr 解析，编码阶段最高98%，校验/提交99%，提交完成100%。取消等待进程树退出后释放锁；达到原子指针提交边界后，不再把已完成提交撤回。默认期限30分钟，可显式设置1ms至6小时。

## 错误与测试

处理错误：`INVALID_OPTIONS / ASSET_NOT_READY / SOURCE_CHANGED / PROCESS_FAILED / TIMEOUT / CANCELLED / PERSISTENCE_ERROR`；共享素材锁/路径检查可能返回 Rewriter 的 `STORE_LOCKED / TASK_NOT_FOUND` 等稳定错误。没有向 UI 暴露原始 stderr。

`tests/studio-core.test.mjs` 使用真实便携 FFmpeg 测试有声/无声素材、分辨率/音轨/元数据、stderr 进度、超时、取消、并发锁、源文件篡改、旧产物保留与导出恢复；还覆盖 AI usage、编辑版本保护及不完整统计记录。
