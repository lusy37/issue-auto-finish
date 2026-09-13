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
describe('单需求草稿创建与核对', () => {
  const content = { title: '完整需求', description: '实现页面与接口', acceptanceCriteria: '联调通过' };
  function fixture() {
    const runner = createMockAIRunner();
    runner.run.mockResolvedValue({ success: true, output: JSON.stringify(content), exitCode: 0 });
    const client = { createIssue: vi.fn(), getIssueDetail: vi.fn(), listIssues: vi.fn().mockResolvedValue([]) };
    const service = new DraftService(dir, runner, client as never, dir, 'https://github.com/demo/repo');
    return { runner, client, service };
  }
  it('编辑单需求后重复确认只创建一个 Issue', async () => {
    const { service, client } = fixture();
    const draft = await service.generate('完成登录功能');
    await service.edit(draft.id, { ...content, title: '登录功能' });
    client.createIssue.mockImplementation(async (_title, body) => ({ number: 5, description: body, html_url: 'https://github.com/demo/repo/issues/5' }));
    const results = await Promise.all([service.confirm(draft.id), service.confirm(draft.id)]);
    expect(results.every(result => result.status === 'created')).toBe(true);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(client.createIssue.mock.calls[0][2]).toEqual(['auto-finish']);
    expect(service.get(draft.id).title).toBe('登录功能');
  });
  it('响应丢失后只核对标记，不再次 POST', async () => {
    const { service, client } = fixture();
    const draft = await service.generate('需求');
    client.createIssue.mockRejectedValue(new Error('响应丢失'));
    expect((await service.confirm(draft.id)).status).toBe('unknown');
    await expect(service.confirm(draft.id)).rejects.toThrow('不能再次');
    expect((await service.reconcile(draft.id, null)).status).toBe('unknown');
    client.listIssues.mockResolvedValue([{ number: 5, description: draft.marker, html_url: 'https://github.com/demo/repo/issues/5' }]);
    expect((await service.reconcile(draft.id)).status).toBe('created');
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });
  it.each(['跨仓库', '错误标记', '查询失败', '重复匹配'])('%s 继续保持 unknown', async kind => {
    const { service, client } = fixture();
    const draft = await service.generate('需求');
    client.createIssue.mockRejectedValue(new Error('响应未知'));
    await service.confirm(draft.id);
    const issue = { number: 7, description: draft.marker, html_url: 'https://github.com/demo/repo/issues/7' };
    if (kind === '跨仓库') issue.html_url = 'https://github.com/other/repo/issues/7';
    if (kind === '错误标记') issue.description = '其他草稿';
    client.getIssueDetail.mockResolvedValue(issue);
    if (kind === '查询失败') client.listIssues.mockRejectedValue(new Error('查询失败'));
    if (kind === '重复匹配') client.listIssues.mockResolvedValue([issue, { ...issue, number: 8 }]);
    expect((await service.reconcile(draft.id, ['跨仓库', '错误标记'].includes(kind) ? 7 : undefined)).status).toBe('unknown');
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });
  it('旧草稿格式启动时报告路径且保留原文件', () => {
    const { runner, client } = fixture();
    const file = path.join(dir, '12345678-1234-1234-1234-123456789012.json');
    fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
    expect(() => new DraftService(dir, runner, client as never, dir, 'https://github.com/demo/repo')).toThrow(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"tasks":[]}');
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
