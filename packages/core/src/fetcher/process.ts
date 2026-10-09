import { spawn } from 'node:child_process';
import { abortError, FetcherError } from './errors.js';

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
}
export interface ProcessResult { exitCode: number | null; stderr: string }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** No shell. Cancellation waits for the entire process tree and inherited pipes to close. */
export const runProcess: ProcessRunner = async ({ executable, args, cwd, signal, onLine }) => {
  if (signal.aborted) throw abortError(signal);
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    // Do not implicitly inherit proxy credentials, Python injection, or a CLI-provided secret.
    for (const key of Object.keys(env)) {
      if (/^(?:https?_proxy|all_proxy|no_proxy|omnipost_proxy|pythonpath|pythonhome|node_options|node_path)$/i.test(key)) delete env[key];
    }
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let spawnFailed = false;
    let killer: ReturnType<typeof spawn> | undefined;
    let killFinished: Promise<void> | undefined;
    const stop = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // taskkill is an OS tool, addressed absolutely rather than through PATH.
        const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
        killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killFinished = new Promise<void>((done) => {
          killer!.once('error', () => { child.kill('SIGKILL'); done(); });
          killer!.once('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let end: number;
      while ((end = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, end).replace(/\r$/, '');
        stdout = stdout.slice(end + 1);
        if (line.length <= 1024 * 1024) { try { onLine(line); } catch { /* observers cannot break process cleanup */ } }
      }
      if (stdout.length > 1024 * 1024) stdout = '';
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-32768); });
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (exitCode) => {
      signal.removeEventListener('abort', stop);
      if (stdout) { try { onLine(stdout); } catch { /* same isolation as above */ } }
      void (async () => {
        await killFinished;
        if (signal.aborted) reject(abortError(signal));
        else if (spawnFailed) reject(new FetcherError('SPAWN_FAILED'));
        else resolve({ exitCode, stderr });
      })();
    });
  });
};
