import { execa, type Options } from 'execa';
import which from 'which';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getIssueContext } from '../context/IssueContext.js';

type ProcessOptions = Pick<Options, 'cwd' | 'env' | 'timeout' | 'cancelSignal' | 'ipc'> & {
  stdio?: 'inherit' | 'ignore' | ['ignore', 'pipe', 'pipe'];
};

/** 统一进程树生命周期；业务调用方只传程序及参数，不拼接 shell 命令。 */
export function spawnProcess(binary: string, args: string[] = [], options: ProcessOptions = {}) {
  return execa(binary, args, {
    ...options,
    windowsHide: true,
    killDescendants: true,
    reject: false,
    buffer: false,
    extendEnv: false,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export type ManagedProcess = ReturnType<typeof spawnProcess>;

const stoppingProcesses = new WeakMap<ManagedProcess, Promise<void>>();

export function findExecutable(binary: string): string | undefined {
  return which.sync(binary, { nothrow: true }) ?? undefined;
}

export function stopProcess(child: ManagedProcess): Promise<void> {
  const existing = stoppingProcesses.get(child);
  if (existing) return existing;
  if (
    !child.pid ||
    child.nodeChildProcess.exitCode !== null ||
    child.nodeChildProcess.signalCode !== null
  ) {
    return Promise.resolve();
  }

  const stopping =
    process.platform === 'win32'
      ? new Promise<void>((resolve) => {
          const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
          const taskkill = windowsRoot
            ? path.join(windowsRoot, 'System32', 'taskkill.exe')
            : 'taskkill.exe';
          execFile(
            taskkill,
            ['/pid', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 10_000 },
            (error) => {
              // 目标可能已自行退出；taskkill 真正失败时至少终止直接子进程。
              if (
                error &&
                child.nodeChildProcess.exitCode === null &&
                child.nodeChildProcess.signalCode === null
              ) {
                child.nodeChildProcess.kill();
              }
              resolve();
            },
          );
        })
      : Promise.resolve().then(() => {
          child.kill();
        });
  stoppingProcesses.set(child, stopping);
  return stopping;
}

export async function runProcess(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  options = { ...options, signal: options.signal ?? getIssueContext()?.signal };
  if (options.signal?.aborted) throw new Error('操作已取消');
  const child = spawnProcess(binary, args, {
    cwd: options.cwd,
    env: options.env,
  });
  let stdout = '',
    stderr = '';
  let callbackError: unknown;
  let terminationReason: 'cancel' | 'timeout' | undefined;
  let stopRequested: Promise<void> | undefined;
  const requestStop = () => (stopRequested ??= stopProcess(child));
  const onAbort = () => {
    terminationReason ??= 'cancel';
    void requestStop();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    terminationReason ??= 'timeout';
    void requestStop();
  }, options.timeoutMs ?? 300_000);
  const emitOutput = (text: string) => {
    try {
      options.onOutput?.(text);
    } catch (error) {
      callbackError ??= error;
      void requestStop();
    }
  };
  // 保留日志尾部，不因构建输出超过缓冲上限而终止命令。
  child.nodeChildProcess.stdout?.setEncoding('utf8').on('data', (text: string) => {
    stdout = (stdout + text).slice(-8_000_000);
    emitOutput(text);
  });
  child.nodeChildProcess.stderr?.setEncoding('utf8').on('data', (text: string) => {
    stderr = (stderr + text).slice(-2_000_000);
    emitOutput(text);
  });
  const lifecycle = getIssueContext();
  let callId: string | undefined;
  let result;
  try {
    if (child.pid) callId = lifecycle?.processStarted?.(child.pid, options.cwd);
    result = await child;
  } catch (error) {
    await requestStop();
    await child;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    if (stopRequested) await stopRequested;
    if (callId) lifecycle?.processExited?.(callId);
  }
  if (callbackError) throw callbackError;
  if (terminationReason === 'timeout') throw new Error('命令执行超时', { cause: result });
  if (terminationReason === 'cancel' || options.signal?.aborted)
    throw new Error('操作已取消', { cause: result });
  if (result.failed && result.exitCode === undefined && !result.isTerminated) throw result;
  return { code: result.exitCode ?? null, stdout, stderr };
}

/** 保留 Windows 反斜杠，支持带空格的命令路径与参数。 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '',
    quote = '';
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = '';
      else token += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else token += c;
  }
  if (quote) throw new Error('命令引号未闭合');
  if (token) tokens.push(token);
  if (!tokens.length) throw new Error('命令不能为空');
  return tokens;
}
