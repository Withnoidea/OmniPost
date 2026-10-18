import type { ElectronAPI, Reply } from '../shared/contracts.js';

export const api: ElectronAPI = new Proxy({} as ElectronAPI, {
  get(_target, prop: string | symbol) {
    const raw = typeof window !== 'undefined' ? (window.electronAPI as unknown as Record<string | symbol, unknown> | undefined) : undefined;
    const value = raw ? raw[prop] : undefined;
    if (typeof value === 'function') {
      return value.bind(raw);
    }
    if (typeof prop === 'string') {
      return async (..._args: unknown[]) => {
        if (!raw || typeof raw[prop] !== 'function') {
          return {
            ok: false,
            error: {
              code: 'RESTART_REQUIRED',
              message: `桌面端核心通道 [${prop}] 尚未加载。请完全退出并重启 OmniPost 桌面端应用以生效最新功能。`,
            },
          };
        }
        return (raw[prop] as (...a: unknown[]) => unknown)(..._args);
      };
    }
    return value;
  },
});

export function unwrap<T>(reply: Reply<T>): T {
  if (!reply || !reply.ok) {
    const code = reply?.error?.code ? ` [${reply.error.code}]` : '';
    const msg = reply?.error?.message ?? '操作失败，请重试。';
    throw new Error(`${msg}${code}`);
  }
  return reply.value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
