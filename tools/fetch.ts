import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadScheduler, FetcherError, resolvePortableTools } from '../packages/core/src/index.js';

const help = `OmniPost Fetcher (developer CLI)
  npm run fetch -- <YouTube/TikTok URL> [more URLs] [options]
  npm run fetch -- --attach <taskId> <local.mp4> [--data DIRECTORY]
  --info-only          Fetch only info JSON + original cover; stop at AWAITING_MEDIA
  --attach TASK_ID     Copy and validate a local MP4; transition to READY
  --proxy URL          HTTP(S)/SOCKS5 proxy; prefer OMNIPOST_PROXY for credentials
  --data DIRECTORY     Durable data root (default: .omnipost)
  --resources DIR      Portable resources directory
  --concurrency N      1..8 workers per lane: metadata / media (default: 2 each)
  --timeout-ms N       Per-operation deadline (default: metadata 15000; download/attach 1800000)
  --list               Show existing tasks, without enqueueing
  --help               Show this help
Proxy is direct by default; HTTP_PROXY/HTTPS_PROXY are not inherited.
Only download media you own or are authorized to use.`;
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      proxy: { type: 'string' }, data: { type: 'string' }, resources: { type: 'string' },
      concurrency: { type: 'string' }, 'timeout-ms': { type: 'string' },
      'info-only': { type: 'boolean' }, attach: { type: 'string' },
      list: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  if (values.help || (!values.list && !values.attach && !values['info-only'] && positionals.length === 0)) { console.log(help); return; }
  if ((values.attach !== undefined && (positionals.length !== 1 || values.list || values['info-only']))
    || (values.list && (positionals.length > 0 || values['info-only']))
    || (values['info-only'] && positionals.length === 0)) throw new FetcherError('INVALID_OPTIONS');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const scheduler = await DownloadScheduler.create({
    dataDirectory: path.resolve(values.data ?? '.omnipost'),
    tools: resolvePortableTools(values.resources ?? path.join(root, 'resources')),
    concurrency: Number(values.concurrency ?? 2),
    timeoutMs: Number(values['timeout-ms'] ?? 1_800_000),
    metadataTimeoutMs: Number(values['timeout-ms'] ?? 15_000),
    onEvent: (event) => {
      if (event.type === 'progress') console.log(JSON.stringify(event));
      else console.log(JSON.stringify({ type: event.type, taskId: event.task.id, state: event.task.state, error: event.task.error }));
    },
  });
  let interrupted = false;
  const stop = (): void => { interrupted = true; process.exitCode = 130; void scheduler.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (values.list) { console.log(JSON.stringify(scheduler.listTasks(), null, 2)); return; }
    const tasks = values.attach !== undefined
      ? [await scheduler.attachLocalMedia(values.attach, positionals[0]!)]
      : await Promise.all(positionals.map(async (url) => {
        const proxy = values.proxy ?? process.env.OMNIPOST_PROXY;
        const options = proxy === undefined ? {} : { proxy };
        if (values['info-only']) return scheduler.fetchMetadata(url, options);
        const task = await scheduler.enqueue({ url, ...options });
        return scheduler.waitFor(task.id);
      }));
    for (const task of tasks) {
      if (['completed', 'READY', 'AWAITING_MEDIA'].includes(task.state) && !task.error) {
        console.log(JSON.stringify({ taskId: task.id, state: task.state, awaitingMedia: task.state === 'AWAITING_MEDIA', assetDirectory: scheduler.getAssetDirectory(task.id) }));
      } else if (!interrupted) process.exitCode = 1;
    }
  } finally {
    await scheduler.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch((error: unknown) => {
  // Avoid dumping argv or native errors which may contain proxy credentials.
  const failure = error instanceof FetcherError ? error.toJSON() : { code: 'CLI_ERROR', message: '命令参数或运行环境异常，请使用 --help 检查。' };
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
});
