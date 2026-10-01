import { AI_DEFAULTS } from '../shared/runtime/defaults.js';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseCodexSessionId } from './SessionId.js';
import { resolveWindowsSandboxMode, type WindowsSandboxMode } from './CodexRunner.js';
import path from 'node:path';
import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnProcess } from '../utils/process.js';
import { ensureDir, resolveDataDir } from '../paths.js';
import type { AIRunner, RunOptions, RunResult, StreamEvent } from './AIRunner.js';
import { ConcurrencyLimiter } from './ConcurrencyLimiter.js';

let globalLimiter = new ConcurrencyLimiter(AI_DEFAULTS.maxConcurrency);
const moduleRequire = createRequire(import.meta.url);

function canWriteDirectory(directory: string): boolean {
  const probe = path.join(directory, `.iaf-codex-home-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      fs.unlinkSync(probe);
    } catch {
      // 探针文件不存在或当前身份无权删除，均表示目录不可写。
    }
    return false;
  }
}

function prepareFallbackCodexHome(nativeHome: string): string {
  const fallbackHome = ensureDir(path.join(resolveDataDir(), 'codex-home'));
  const sourceConfig = path.join(nativeHome, 'config.toml');
  const fallbackConfig = path.join(fallbackHome, 'config.toml');
  try {
    if (
      fs.existsSync(sourceConfig) &&
      (!fs.existsSync(fallbackConfig) ||
        fs.statSync(sourceConfig).mtimeMs > fs.statSync(fallbackConfig).mtimeMs)
    )
      fs.copyFileSync(sourceConfig, fallbackConfig);
  } catch {
    // 没有可复制的本机配置时仍保留隔离目录，调用方可通过环境变量认证。
  }
  return fallbackHome;
}

export function configureAIConcurrency(limit: number): void {
  if (globalLimiter.limit === limit) return;
  if (globalLimiter.running || globalLimiter.waiting) throw new Error('修改 AI 并发需重启服务');
  globalLimiter = new ConcurrencyLimiter(limit);
}
export class ManagedCodexRunner implements AIRunner {
  private calls = new Map<AbortController, string>();
  private idleWaiters = new Set<() => void>();
  async waitForIdle(): Promise<void> {
    if (this.calls.size) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
  constructor(
    private binary = '',
    private model?: string,
    private windowsSandbox: WindowsSandboxMode = resolveWindowsSandboxMode(),
  ) {}
  canResumeSession(sessionId: string): boolean {
    return parseCodexSessionId(sessionId) !== undefined;
  }
  killAll(): void {
    for (const controller of this.calls.keys()) controller.abort();
  }
  killByWorkDir(workDir: string): number {
    let count = 0;
    const key = (dir: string) =>
      process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    for (const [controller, dir] of this.calls)
      if (key(dir) === key(workDir)) {
        controller.abort();
        count++;
      }
    return count;
  }
  protected workerEntrypoint(): { file: string; source: boolean } {
    const source = import.meta.url.endsWith('.ts');
    return {
      source,
      file: fileURLToPath(new URL(source ? './sdk-worker.ts' : './sdk-worker.js', import.meta.url)),
    };
  }

  protected workerArguments(worker: string, source: boolean): string[] {
    if (!source) return [worker];
    const tsxLoader = pathToFileURL(moduleRequire.resolve('tsx')).href;
    return ['--import', tsxLoader, worker];
  }

  protected codexEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    const home = environment.USERPROFILE || environment.HOME;
    if (!environment.HOME && home) environment.HOME = home;
    if (!environment.CODEX_HOME && home) {
      const nativeHome = path.join(home, '.codex');
      if (!canWriteDirectory(nativeHome))
        environment.CODEX_HOME = prepareFallbackCodexHome(nativeHome);
    }
    return environment;
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
      const maximum =
        options.timeoutMs +
        Math.max(0, options.timeoutMaxExtensions ?? 0) * (options.timeoutExtensionMs ?? 600000) +
        10000;
      watchdog = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, maximum);
      const { source, file: worker } = this.workerEntrypoint();
      const child = spawnProcess(
        process.execPath,
        this.workerArguments(worker, source),
        {
          cwd: options.workDir,
          cancelSignal: controller.signal,
          env: this.codexEnvironment(),
          ipc: true,
        },
      );
      let result: RunResult | undefined;
      let diagnostic = '';
      child.nodeChildProcess.stderr?.on('data', (data) => {
        diagnostic = (diagnostic + String(data)).slice(-10000);
      });
      child.nodeChildProcess.stdout?.resume();
      child.nodeChildProcess.on(
        'message',
        (message: { type: string; result?: RunResult; event?: StreamEvent }) => {
          if (message.type === 'result') result = message.result;
          if (message.type === 'event' && message.event && !controller.signal.aborted) {
            try {
              options.onStreamEvent?.(message.event);
            } catch (error) {
              diagnostic = (error as Error).message;
              controller.abort();
            }
          }
        },
      );
      try {
        if (!child.pid) throw new Error('SDK worker 未取得进程身份');
        options.onWorkerStarted?.(child.pid);
        const {
          onStreamEvent: _stream,
          signal: _signal,
          onWorkerStarted: _started,
          ...serializable
        } = options;
        child.nodeChildProcess.send({
          binary: this.binary,
          model: this.model,
          windowsSandbox: this.windowsSandbox,
          options: serializable,
        });
      } catch (error) {
        controller.abort();
        await child;
        throw error;
      }
      const exited = await child;
      if (controller.signal.aborted)
        return {
          success: false,
          output: result?.output ?? '',
          errorMessage: timedOut
            ? 'SDK worker 超时，已终止并等待进程退出'
            : result?.errorMessage || diagnostic || '调用已取消并等待进程退出',
          timeoutType: timedOut ? 'wall-clock' : undefined,
          exitCode: exited.exitCode ?? null,
        };
      if (!result || exited.exitCode !== 0)
        return {
          success: false,
          output: '',
          errorMessage: diagnostic || 'SDK worker 未返回完整结果',
          exitCode: exited.exitCode ?? null,
        };
      return result;
    } finally {
      // 只有 child 的退出已被等待，才会执行此处并释放额度。
      release?.();
      clearTimeout(watchdog);
      this.calls.delete(controller);
      if (!this.calls.size) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
