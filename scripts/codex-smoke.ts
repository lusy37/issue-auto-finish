import fs from "node:fs";
import path from "node:path";
import { ManagedCodexRunner } from "../src/ai-runner/ManagedCodexRunner.js";
import { runProcess } from "../src/utils/process.js";
import { getGlobalDir, ensureDir } from "../src/paths.js";

// 每次使用新目录，避免把旧文件误当成真实调用产物。
const root = ensureDir(path.join(getGlobalDir(), "codex-smoke"));
const workDir = fs.mkdtempSync(path.join(root, "中文 测试 "));
await runProcess("git", ["init"], { cwd: workDir });
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS || 120000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 30000) {
  throw new Error("CODEX_SMOKE_TIMEOUT_MS 必须是至少 30000 毫秒的数字");
}
const runner = new ManagedCodexRunner(
  process.env.CODEX_BINARY || "",
  process.env.AI_MODEL || undefined,
);
const startedAt = new Date().toISOString();
const events: Array<{ type: string; content: string; timestamp: string }> = [];
const result = await runner.run({
  workDir,
  timeoutMs,
  mode: "agent",
  prompt: [
    "这是一个 Windows 兼容性 smoke test。",
    "只在当前工作目录内创建 add.cjs 和 add.test.cjs，不读取目录外文件，不安装依赖。",
    "add.cjs 导出 add(a,b)，返回两数之和；add.test.cjs 使用 node:test 测试 add(2,3)===5。",
    "运行 node --test add.test.cjs，并简要报告结果。",
    "创建文件时只使用 Windows PowerShell 或 node -e。禁止使用 bash/sh heredoc、apply_patch、管道输入以及依赖外部补丁工具。",
    "完成后确认两个文件确实存在，并再次运行测试。",
  ].join("\n"),
  onStreamEvent: event => {
    const serialized = JSON.stringify(event.content);
    const content =
      typeof event.content === "string"
        ? event.content.slice(-1000)
        : (serialized ?? "").slice(-1000);
    events.push({ type: event.type, content, timestamp: event.timestamp });
    if (events.length > 30) events.shift();
  },
});
const created =
  fs.existsSync(path.join(workDir, "add.cjs")) &&
  fs.existsSync(path.join(workDir, "add.test.cjs"));
const verification = created
  ? await runProcess(process.execPath, ["--test", "add.test.cjs"], {
      cwd: workDir,
      timeoutMs: 15000,
    })
  : undefined;
const passed = result.success && created && verification?.code === 0;
const controller = new AbortController();
let workerPid: number | undefined;
const stopping = runner.run({ workDir, timeoutMs: 60000, signal: controller.signal, onWorkerStarted: pid => { workerPid = pid; setTimeout(() => controller.abort(), 2500); }, mode: 'plan', prompt: '只读检查当前 add.cjs 与测试文件，说明测试覆盖情况。不要改动任何文件。' });
const aborted = await stopping.catch(error => ({ success: false, errorMessage: String(error) }));
await runner.waitForIdle();
let exited = true;
if (workerPid) { try { process.kill(workerPid, 0); exited = false; } catch (error) { exited = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
const cancellation = { workerPid, cancelled: controller.signal.aborted, exited, result: aborted };
const report = {
  cancellation,
  startedAt,
  finishedAt: new Date().toISOString(),
  workDir,
  timeoutMs,
  recentEvents: events,
  passed,
  result,
  verification,
};
fs.writeFileSync(
  path.join(workDir, "result.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      passed,
      created,
      cancellation: { cancelled: cancellation.cancelled, exited: cancellation.exited },
      exitCode: result.exitCode,
      error: result.errorMessage,
      timeoutMs,
      report: path.join(workDir, "result.json"),
    },
    null,
    2,
  ),
);
process.exitCode = passed && cancellation.cancelled && cancellation.exited ? 0 : 1;
