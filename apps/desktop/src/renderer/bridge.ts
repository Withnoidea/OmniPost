import type { Reply } from '../shared/contracts.js';
export const api = window.electronAPI;
export function unwrap<T>(reply: Reply<T>): T { if (!reply.ok) throw new Error(`${reply.error.message} [${reply.error.code}]`); return reply.value; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试。'; }
