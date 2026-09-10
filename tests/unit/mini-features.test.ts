import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DraftService } from "../../src/demand/DraftService.js";
import { summarizeTasks } from "../../src/analytics/TaskAnalytics.js";
import { IssueState, type IssueRecord } from "../../src/tracker/IssueState.js";
import {
  validateUatReport,
  executeUat,
} from "../../src/e2e/PlaywrightRunner.js";
import { acquireInstanceLock } from "../../src/utils/InstanceLock.js";
import { splitCommand, runProcess } from "../../src/utils/process.js";
import { createMockAIRunner } from "../helpers/mock-factories.js";
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
describe("轻量草稿", () => {
  it("部分失败后保留成功项，结果未知时禁止重发，核对后可继续", async () => {
    const runner = createMockAIRunner();
    runner.run.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        tasks: [
          {
            title: "前端",
            description: "展示任务",
            acceptanceCriteria: "页面显示任务列表",
          },
          {
            title: "后端",
            description: "读取任务",
            acceptanceCriteria: "返回任务记录",
          },
        ],
      }),
      exitCode: 0,
    });
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({ number: 10 })
      .mockRejectedValueOnce(new Error("连接断开"))
      .mockResolvedValue({ number: 11 });
    const service = new DraftService(
      dir,
      runner,
      { createIssue } as never,
      dir,
      "https://example.test/demo",
    );
    const batch = await service.generate("实现工作台");
    await service.edit(batch.id, batch.tasks[0].id, {
      ...batch.tasks[0],
      title: "新前端",
    });
    const result = await service.confirm(
      batch.id,
      batch.tasks.map((t) => t.id),
    );
    expect(result.tasks.map((t) => t.status)).toEqual(["created", "unknown"]);
    await expect(
      service.confirm(
        batch.id,
        batch.tasks.map((t) => t.id),
      ),
    ).rejects.toThrow("结果未知");
    expect(createIssue).toHaveBeenCalledTimes(2);
    await service.reconcile(batch.id, batch.tasks[1].id, null);
    await service.confirm(
      batch.id,
      batch.tasks.map((t) => t.id),
    );
    expect(createIssue).toHaveBeenCalledTimes(3);
    expect(
      service.get(batch.id).tasks.every((t) => t.status === "created"),
    ).toBe(true);
    expect(
      new DraftService(
        dir,
        runner,
        { createIssue } as never,
        dir,
        "https://example.test",
      ).list()[0].tasks[0].title,
    ).toBe("新前端");
  });
  it("上次创建中断显示结果未知，不能把未知结果当作未创建", async () => {
    const runner = createMockAIRunner();
    const id = "12345678-1234-1234-1234-123456789012";
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({
        id,
        createdAt: "2026-09-09",
        input: "x",
        tasks: [{ id: "1", status: "creating" }],
      }),
    );
    expect(
      new DraftService(
        dir,
        runner,
        { createIssue: vi.fn() } as never,
        dir,
        "x",
      ).get(id).tasks[0].status,
    ).toBe("unknown");
  });
});
describe("本工具任务统计", () => {
  const record = (
    state: IssueState,
    extra: Partial<IssueRecord> = {},
  ): IssueRecord =>
    ({
      state,
      attempts: 0,
      branchName: "demo",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:01:00Z",
      ...extra,
    }) as IssueRecord;
  it("排除进行中、审核和取消；重试成功只计一个成功任务", () => {
    const data = summarizeTasks(
      [
        record(IssueState.Completed, { retryCount: 2 }),
        record(IssueState.Failed),
        record(IssueState.PhaseWaiting),
        record(IssueState.Cancelled),
        record(IssueState.PhaseRunning),
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
        record(IssueState.PhaseWaiting, {
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
        [record(IssueState.Completed)],
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
  it("配置缺失时保留本次失败摘要，不复用旧通过报告", async () => {
    vi.stubEnv("DATA_DIR", dir);
    const old = path.join(dir, "uat", "old");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, "summary.json"),
      JSON.stringify({ passed: true }),
    );
    const result = await executeUat({
      issueIid: 1,
      workDir: dir,
      configFile: "missing.ts",
      baseUrl: "http://localhost:1",
      timeoutMs: 1000,
    });
    expect(result.passed).toBe(false);
    expect(result.runId).not.toBe("old");
    expect(
      fs.existsSync(path.join(dir, "uat", result.runId, "summary.json")),
    ).toBe(true);
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
