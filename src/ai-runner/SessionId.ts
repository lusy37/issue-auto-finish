const SESSION_PREFIX = 'codex:';

export function parseCodexSessionId(value: string): string | undefined {
  if (!value.startsWith(SESSION_PREFIX)) return undefined;
  return value.slice(SESSION_PREFIX.length) || undefined;
}

export function codexSessionId(threadId: string): string {
  if (!threadId) throw new Error('线程标识不能为空');
  return SESSION_PREFIX + threadId;
}
