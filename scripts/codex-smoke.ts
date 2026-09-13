import fs from "node:fs";
import path from "node:path";
import { ManagedCodexRunner } from "../src/ai-runner/ManagedCodexRunner.js";
import { runProcess } from "../src/utils/process.js";
import { getGlobalDir, ensureDir } from "../src/paths.js";

// 每次使用新目录，避免把旧文件误当成真实调用产物。
const root = ensureDir(path.join(getGlobalDir(), "codex-smoke"));
const workDir = fs.mkdtempSync(path.join(root, "中文 测试 "));
await runProcess("git", ["init"], { cwd: workDir });
const runner = new ManagedCodexRunner(
  process.env.CODEX_BINARY || "",
  process.env.AI_MODEL || undefined,
);
const startedAt = new Date().toISOString();
const result = await runner.run({
  workDir,
  timeoutMs: 120000,
  mode: "agent",
  prompt:
    "在当前目录创建 add.cjs，导出 add(a,b) 返回两数之和；创建 add.test.cjs 使用 node:test 测试 add(2,3)===5。运行 node --test add.test.cjs。只修改当前目录内这两个文件，不读取目录外文件，不安装依赖。完成后简要报告结果。",
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
      report: path.join(workDir, "result.json"),
    },
    null,
    2,
  ),
);
process.exitCode = passed && cancellation.cancelled && cancellation.exited ? 0 : 1;
