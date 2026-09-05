import fs from "node:fs";
import path from "node:path";
import {
  spawn as nativeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import crossSpawn from "cross-spawn";

/** 统一 Windows 的脚本扩展名及参数转义，禁止调用方拼接命令。 */
export const spawnProcess: typeof nativeSpawn = ((
  binary: string,
  args: string[] = [],
  options: SpawnOptions = {},
) =>
  crossSpawn(binary, args, {
    windowsHide: true,
    ...options,
  })) as typeof nativeSpawn;

export function findExecutable(binary: string): string | undefined {
  const dirs =
    path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
      ? [""]
      : (process.env.PATH ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32" && !path.extname(binary)
      ? ["", ".exe", ".com", ".cmd", ".bat"]
      : [""];
  for (const dir of dirs)
    for (const ext of extensions) {
      const candidate = path.resolve(dir, binary + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续查找 */
      }
    }
  return undefined;
}

/** Windows 需要同时终止 npm/AI 启动的子进程，避免残留端口。 */
export function stopProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = nativeSpawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (process.env.IAF_PROCESS_DEBUG) {
      console.log("终止进程", child.pid);
      killer.stdout?.on("data", (d) => console.log(d.toString()));
      killer.stderr?.on("data", (d) => console.log(d.toString()));
    }
    const fallback = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    killer.on("error", fallback);
    killer.on("exit", (code) => {
      if (code !== 0) fallback();
    });
  } else child.kill(signal);
}

export function runProcess(
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
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("操作已取消"));
      return;
    }
    const child = spawnProcess(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timeout = false;
    const abort = () => stopProcess(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timeout = true;
      abort();
    }, options.timeoutMs ?? 300_000);
    const clean = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-8_000_000);
      options.onOutput?.(data.toString());
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2_000_000);
      options.onOutput?.(data.toString());
    });
    child.on("error", (err) => {
      clean();
      reject(err);
    });
    child.on("close", (code) => {
      clean();
      if (timeout || options.signal?.aborted)
        reject(new Error(timeout ? "命令执行超时" : "操作已取消"));
      else resolve({ code, stdout, stderr });
    });
  });
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
