import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { summarizeTasks } from "../../src/analytics/TaskAnalytics.js";
import type { IssueRecord } from "../../src/tracker/IssueRecord.js";
import type { IssueLifecycle } from "../../src/tracker/IssueLifecycle.js";
import { newIssueRun } from "../../src/dag/contracts.js";
import {
  validateUatReport,
  executeUat,
} from "../../src/e2e/PlaywrightRunner.js";
import { acquireInstanceLock } from "../../src/utils/InstanceLock.js";
import { splitCommand, runProcess } from "../../src/utils/process.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});
describe("本工具任务统计", () => {
  const record = (
    lifecycle: IssueLifecycle,
    extra: Partial<IssueRecord> = {},
  ): IssueRecord => {
    return {
      lifecycle,
      branchName: "demo",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:01:00Z",
      demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '任务', description: '', createdAt: '2026-09-08T00:00:00Z' },
      run: newIssueRun(),
      phaseHistory: [],
      ...extra,
    };
  };
  it("排除进行中、审核和取消；重试成功只计一个成功任务", () => {
    const data = summarizeTasks(
      [
        record({ kind: 'completed' }, { run: { ...newIssueRun(), retryUsed: { build: 2 } } }),
        record({ kind: 'failed', retry: 'manual', error: { message: '失败', retryable: 'hard-no-auto' } }),
        record({ kind: 'waiting', phase: 'review' }),
        record({ kind: 'cancelled' }),
        record({ kind: 'running', phase: 'build' }),
      ],
      "all",
    );
    expect(data.total).toBe(5);
    expect(data.successRate).toBe(0.5);
    expect(data.completed).toBe(1);
    expect(data.retries).toBe(2);
    expect(data.totalDurationMs).toBe(120000);
  });
  it("无终态样本返回 null，实际阶段耗时排除人工等待", () => {
    const data = summarizeTasks(
      [
        record({ kind: 'waiting', phase: 'review' }, {
          phaseHistory: [
            {
              phaseId: "plan",
              attemptId: 1,
              startedAt: "2026-09-08T00:00:00Z",
              endedAt: "2026-09-08T00:00:05Z",
              outcome: "completed",
            },
            {
              phaseId: "review",
              attemptId: 1,
              startedAt: "2026-09-08T00:00:05Z",
              endedAt: "2026-09-08T00:01:00Z",
              outcome: "gate-approved",
            },
          ],
        }),
      ],
      "all",
    );
    expect(data.successRate).toBeNull();
    expect(data.phases.plan.durationMs).toBe(5000);
    expect(data.phases.review).toBeUndefined();
    expect(data.interventions).toBe(1);
  });
  it("时间筛选按创建日期", () => {
    expect(
      summarizeTasks(
        [record({ kind: 'completed' })],
        "7d",
        Date.parse("2026-09-30"),
      ).total,
    ).toBe(0);
  });
});
describe("浏览器验收判定", () => {
  const report = (expected: number, unexpected = 0, skipped = 0) => ({
    stats: { expected, unexpected, flaky: 0, skipped },
    errors: [],
  });
  it.each([
    [0, 0, 0, 0, false],
    [0, 0, 3, 0, false],
    [1, 1, 0, 1, false],
    [1, 0, 0, 1, false],
    [1, 0, 0, 0, true],
  ])(
    "通过=%s 失败=%s 跳过=%s 退出=%s",
    (passed, failed, skipped, code, result) => {
      expect(
        validateUatReport(
          report(Number(passed), Number(failed), Number(skipped)),
          Number(code),
        ).passed,
      ).toBe(result);
    },
  );
  it("报告结构缺失、负数或非数字拒绝通过", () => {
    for (const value of [
      {},
      { stats: { expected: -1, unexpected: 0, flaky: 0, skipped: 0 } },
      { stats: { expected: "2", unexpected: 0, flaky: 0, skipped: 0 } },
    ])
      expect(() => validateUatReport(value, 0)).toThrow();
  });
  it("测试断言错误与运行环境错误分别分类", () => {
    const assertionFailure = validateUatReport({
      ...report(0, 1),
      suites: [{
        specs: [{
          id: 'assertion',
          title: '断言失败',
          tests: [{
            expectedStatus: 'passed',
            status: 'unexpected',
            results: [{
              status: 'failed',
              error: { message: '预期标题为修复完成' },
              attachments: [],
            }],
          }],
        }],
      }],
    }, 1);
    expect(assertionFailure.reportErrors).toEqual(['预期标题为修复完成']);
    expect(assertionFailure.failureKind).toBe('assertion');

    expect(validateUatReport({
      ...report(0),
      errors: [{ message: 'browserType.launch 找不到浏览器' }],
    }, 1).failureKind).toBe('environment');
  });
  it("配置缺失时保留本次机器失败，不复用旧通过报告", async () => {
    vi.stubEnv("DATA_DIR", dir);
    const old = path.join(dir, "uat", "old");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, "summary.json"),
      JSON.stringify({ passed: true }),
    );
    const result = await executeUat({
      issueIid: 1,
      dataDir: dir,
      workDir: dir,
      configFile: "missing.ts",
      baseUrl: "http://localhost:1",
      timeoutMs: 1000,
    });
    expect(result.reportValid).toBe(false);
    expect(result.reportValid).toBe(false);
    expect(result.runId).not.toBe("old");
    expect(
      fs.existsSync(path.join(dir, "uat", result.runId, "machine.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(dir, "uat", result.runId, "summary.json")),
    ).toBe(false);
  });
});
describe("本机互斥和 Windows 命令", () => {
  it("阻止第二实例，释放后重新获取", () => {
    const release = acquireInstanceLock(dir);
    expect(() => acquireInstanceLock(dir)).toThrow();
    release();
    acquireInstanceLock(dir)();
  });
  it("解析中文和空格路径，保留反斜杠", () => {
    expect(splitCommand('"C:\\中文 空格\\node.exe" "脚本 文件.js"')).toEqual([
      "C:\\中文 空格\\node.exe",
      "脚本 文件.js",
    ]);
  });
  it("执行位于中文空格目录的子进程并获取真实退出码", async () => {
    const cwd = path.join(dir, "中文 空格");
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(cwd, "测试.js"),
      "console.log(process.argv[2]);process.exitCode=7;",
    );
    const result = await runProcess(
      process.execPath,
      ["测试.js", "中文 参数"],
      { cwd },
    );
    expect(result.code).toBe(7);
    expect(result.stdout.trim()).toBe("中文 参数");
  });
  it("超时结束进程", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: dir,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("超时");
  });
});
