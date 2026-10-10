import { parseArgs } from 'node:util';
import path from 'node:path';
import { AIRewriter, RewriterError, type RewriteOptions, type TargetPlatform } from '../packages/core/src/index.js';

const help = `OmniPost Rewriter (developer CLI)
  npm run rewrite -- <taskId> --platform xhs,bili [options]
  --platform LIST      xhs,bili,dy,ks or xiaohongshu,bilibili,douyin,kuaishou
  --data DIRECTORY     Same durable data root as fetch (default: .omnipost)
  --base-url URL       API root, e.g. https://api.deepseek.com/v1 or http://localhost:11434/v1
  --model NAME         Default: deepseek-chat; api.openai.com defaults to gpt-4o-mini
  --api-key KEY        Prefer OMNIPOST_LLM_API_KEY; never written to assets/logs
  --temperature N      0..2 (default: 0.7)
  --timeout-ms N       Per-platform HTTP deadline (default: 60000)
  --max-tokens N       128..8192 (default: 2048)
  --no-json-mode       Omit response_format for older compatible endpoints
  --help               Show help
Environment: OMNIPOST_LLM_API_KEY, OMNIPOST_LLM_BASE_URL, OMNIPOST_LLM_MODEL.
Only selected source text is sent to the configured provider. Review generated copy before publishing.`;
const aliases: Record<string, TargetPlatform> = {
  xhs: 'xiaohongshu', bili: 'bilibili', dy: 'douyin', ks: 'kuaishou',
  xiaohongshu: 'xiaohongshu', bilibili: 'bilibili', douyin: 'douyin', kuaishou: 'kuaishou',
};
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: 'string' }, data: { type: 'string' }, 'base-url': { type: 'string' }, model: { type: 'string' },
      'api-key': { type: 'string' }, temperature: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-tokens': { type: 'string' },
      'no-json-mode': { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  if (values.help || (process.argv.length === 2)) { console.log(help); return; }
  if (positionals.length !== 1 || !values.platform) throw new RewriterError('INVALID_OPTIONS');
  const platforms = values.platform.split(',').map((name) => {
    const key = name.trim().toLowerCase();
    if (!Object.hasOwn(aliases, key)) throw new RewriterError('INVALID_PLATFORM');
    return aliases[key]!;
  });
  const controller = new AbortController();
  const options: RewriteOptions = {
    temperature: Number(values.temperature ?? 0.7), timeoutMs: Number(values['timeout-ms'] ?? 60_000),
    maxTokens: Number(values['max-tokens'] ?? 2048), jsonMode: !values['no-json-mode'], signal: controller.signal,
  };
  const apiKey = values['api-key'] ?? process.env.OMNIPOST_LLM_API_KEY;
  const baseURL = values['base-url'] ?? process.env.OMNIPOST_LLM_BASE_URL;
  const model = values.model ?? process.env.OMNIPOST_LLM_MODEL;
  if (apiKey !== undefined) options.apiKey = apiKey;
  if (baseURL !== undefined) options.baseURL = baseURL;
  if (model !== undefined) options.model = model;
  let interrupted = false;
  const stop = (): void => { interrupted = true; controller.abort(); process.exitCode = 130; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const rewriter = new AIRewriter({
      dataDirectory: path.resolve(values.data ?? '.omnipost'), ...options,
      onProgress: (event) => console.log(JSON.stringify({ type: 'progress', ...event })),
      onError: (taskId, platform, error) => console.log(JSON.stringify({ type: 'failure', taskId, platform, error })),
    });
    const result = await rewriter.rewriteTask(positionals[0]!, platforms);
    console.log(JSON.stringify({ taskId: result.taskId, state: result.state, requestedPlatforms: result.requestedPlatforms, errors: result.errors, outputFile: result.outputFile }));
    if (!interrupted && result.state !== 'completed') process.exitCode = 1;
  } catch (error) {
    if (!interrupted) throw error;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify(error instanceof RewriterError ? error.toJSON() : new RewriterError('INVALID_OPTIONS').toJSON()));
  process.exitCode = 1;
});
