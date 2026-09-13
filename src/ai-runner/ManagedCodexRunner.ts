import path from 'node:path';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { fileURLToPath } from 'node:url';
import { spawnProcess } from '../utils/process.js';
import type { AIRunner, RunOptions, RunResult, StreamEvent } from './AIRunner.js';
import { ConcurrencyLimiter } from './ConcurrencyLimiter.js';

let globalLimiter = new ConcurrencyLimiter(4);
export function configureAIConcurrency(limit: number): void {
  if (globalLimiter.limit === limit) return;
  if (globalLimiter.running || globalLimiter.waiting) throw new Error('修改 AI 并发需重启服务');
  globalLimiter = new ConcurrencyLimiter(limit);
}
export class ManagedCodexRunner implements AIRunner {
  private calls = new Map<AbortController, string>();
  private idleWaiters = new Set<() => void>();
  async waitForIdle(): Promise<void> {
    if (this.calls.size) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }
  constructor(private binary = '', private model?: string) {}
  canResumeSession(sessionId: string): boolean { return sessionId.startsWith('codex:') && sessionId.length > 6; }
  killAll(): void { for (const controller of this.calls.keys()) controller.abort(); }
  killByWorkDir(workDir: string): number {
    let count = 0;
    const key = (dir: string) => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    for (const [controller, dir] of this.calls) if (key(dir) === key(workDir)) { controller.abort(); count++; }
    return count;
  }
  protected workerEntrypoint(): { file: string; source: boolean } {
    const source = import.meta.url.endsWith('.ts');
    return { source, file: fileURLToPath(new URL(source ? './sdk-worker.js' : './sdk-worker.js', import.meta.url)) };
  }
  async run(options: RunOptions): Promise<RunResult> {
    if (isShuttingDown()) throw new Error('服务正在停止，不能启动新的 SDK 调用');
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.calls.set(controller, options.workDir);
    let release: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      release = await globalLimiter.acquire(controller.signal);
      controller.signal.throwIfAborted();
      // SDK 内部允许有限续时；外层监护保证 worker 卡死时也有确定的终止边界。
      const maximum = options.timeoutMs + Math.max(0, options.timeoutMaxExtensions ?? 0) * (options.timeoutExtensionMs ?? 600000) + 10000;
      watchdog = setTimeout(() => { timedOut = true; controller.abort(); }, maximum);
      const { source, file: worker } = this.workerEntrypoint();
      const child = spawnProcess(process.execPath, [...(source ? ['--import', 'tsx'] : []), worker], { cwd: options.workDir, cancelSignal: controller.signal, ipc: true });
      let result: RunResult | undefined;
      let diagnostic = '';
      child.nodeChildProcess.stderr?.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-10000); });
      child.nodeChildProcess.stdout?.resume();
      child.nodeChildProcess.on('message', (message: { type: string; result?: RunResult; event?: StreamEvent }) => {
        if (message.type === 'result') result = message.result;
        if (message.type === 'event' && message.event && !controller.signal.aborted) {
          try { options.onStreamEvent?.(message.event); }
          catch (error) { diagnostic = (error as Error).message; controller.abort(); }
        }
      });
      try {
        if (!child.pid) throw new Error('SDK worker 未取得进程身份');
        options.onWorkerStarted?.(child.pid);
        const { onStreamEvent: _stream, signal: _signal, onWorkerStarted: _started, ...serializable } = options;
        child.nodeChildProcess.send({ binary: this.binary, model: this.model, options: serializable });
      } catch (error) {
        controller.abort();
        await child;
        throw error;
      }
      const exited = await child;
      if (controller.signal.aborted) return { success: false, output: result?.output ?? '', errorMessage: timedOut ? 'SDK worker 超时，已终止并等待进程退出' : '调用已取消并等待进程退出', timeoutType: timedOut ? 'wall-clock' : undefined, exitCode: exited.exitCode ?? null };
      if (!result || exited.exitCode !== 0) return { success: false, output: '', errorMessage: diagnostic || 'SDK worker 未返回完整结果', exitCode: exited.exitCode ?? null };
      return result;
    } finally {
      // 只有 child 的退出已被等待，才会执行此处并释放额度。
      release?.();
      clearTimeout(watchdog);
      this.calls.delete(controller);
      if (!this.calls.size) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
