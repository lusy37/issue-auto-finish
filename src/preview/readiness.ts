import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export interface ReadinessTarget {
  port: number;
  url?: string;
}

async function probe(target: ReadinessTarget, signal: AbortSignal): Promise<boolean> {
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
  if (target.url) {
    try {
      const response = await fetch(target.url.replaceAll('{port}', String(target.port)), {
        signal: attemptSignal,
        redirect: 'manual',
      });
      await response.body?.cancel();
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  }
  // TCP 只能证明已监听；项目配置了 HTTP 地址时必须再满足响应状态条件。
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: target.port });
    const finish = (ready: boolean) => {
      attemptSignal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    attemptSignal.addEventListener('abort', abort, { once: true });
    if (attemptSignal.aborted) abort();
  });
}

export async function waitForReadiness(
  targets: readonly ReadinessTarget[],
  timeoutMs: number,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);
  try {
    while (true) {
      combined.throwIfAborted();
      const ready = await Promise.all(targets.map((target) => probe(target, combined)));
      combined.throwIfAborted();
      if (ready.every(Boolean)) return;
      await delay(intervalMs, undefined, { signal: combined });
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted)
      throw new Error(
        `预览在 ${timeoutMs}ms 内未就绪：${targets.map((target) => target.url?.replaceAll('{port}', String(target.port)) ?? `127.0.0.1:${target.port}`).join('、')}`,
      );
    throw error;
  }
}
