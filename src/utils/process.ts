import { execa, type Options } from "execa";
import which from "which";

type ProcessOptions = Pick<Options, "cwd" | "env" | "timeout" | "cancelSignal"> & { stdio?: "inherit" | "ignore" | ["ignore", "pipe", "pipe"] };

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
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

export type ManagedProcess = ReturnType<typeof spawnProcess>;

export function findExecutable(binary: string): string | undefined {
  return which.sync(binary, { nothrow: true }) ?? undefined;
}

export function stopProcess(child: ManagedProcess): void {
  if (child.pid && child.nodeChildProcess.exitCode === null) child.kill();
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
  if (options.signal?.aborted) throw new Error("操作已取消");
  const child = spawnProcess(binary, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 300_000,
    cancelSignal: options.signal,
  });
  let stdout = "", stderr = "";
  // 保留日志尾部，不因构建输出超过缓冲上限而终止命令。
  child.nodeChildProcess.stdout?.setEncoding("utf8").on("data", (text: string) => {
    stdout = (stdout + text).slice(-8_000_000);
    options.onOutput?.(text);
  });
  child.nodeChildProcess.stderr?.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-2_000_000);
    options.onOutput?.(text);
  });
  const result = await child;
  if (result.timedOut) throw new Error("命令执行超时", { cause: result });
  if (result.isCanceled || options.signal?.aborted) throw new Error("操作已取消", { cause: result });
  if (result.failed && result.exitCode === undefined && !result.isTerminated) throw result;
  return { code: result.exitCode ?? null, stdout, stderr };
}

/** 保留 Windows 反斜杠，支持带空格的命令路径与参数。 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "",
    quote = "";
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = "";
      else token += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else token += c;
  }
  if (quote) throw new Error("命令引号未闭合");
  if (token) tokens.push(token);
  if (!tokens.length) throw new Error("命令不能为空");
  return tokens;
}
