import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { envSchema, transformEnvToConfig } from "../../src/config-schema.js";
import { IssueTracker } from "../../src/tracker/IssueTracker.js";
import { IssueState } from "../../src/tracker/IssueState.js";
import {
  buildPlanModePipeline,
  createLifecycleManager,
  registerPipeline,
} from "../../src/pipeline/PipelineDefinition.js";
import { PipelineOrchestrator } from "../../src/orchestrator/PipelineOrchestrator.js";
import { GitOperations } from "../../src/git/GitOperations.js";
import {
  GitHubClient,
  type GitHubIssue,
} from "../../src/clients/GitHubClient.js";
import type { AIRunner, RunOptions } from "../../src/ai-runner/AIRunner.js";
import { SupplementStore } from "../../src/supplement/SupplementStore.js";
import { AsyncMutex } from "../../src/utils/AsyncMutex.js";
import { summarizeTasks } from "../../src/analytics/TaskAnalytics.js";
import { DiaryCollector } from "../../src/distill/DiaryCollector.js";
import { DiaryStore } from "../../src/distill/DiaryStore.js";
import { PlanPersistence } from "../../src/persistence/PlanPersistence.js";

const base = path.resolve(".iaf-mini/test-workflow");
let dir: string, previous: string | undefined;
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
beforeEach(() => {
  fs.mkdirSync(base, { recursive: true });
  dir = fs.mkdtempSync(path.join(base, "中文 仓库 "));
  previous = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(dir, "data");
});
afterEach(() => {
  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
  vi.restoreAllMocks();
});

describe("完整流程：真实 Git 与浏览器、模拟 AI 和平台", () => {
  it("驳回重做 → 修复 → Chromium 验收 → 交付失败仅重试交付 → 日记与统计", async () => {
    const origin = path.join(dir, "origin.git"),
      repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(dir, "init", "--bare", origin);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Mini Demo");
    git(repo, "config", "user.email", "demo@example.test");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "README.md"), "# 演示项目\n");
    fs.writeFileSync(
      path.join(repo, "server.mjs"),
      "import http from 'node:http';import fs from 'node:fs';http.createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'));}).listen(Number(process.argv[2]),'127.0.0.1');",
    );
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      "node_modules/\n.iaf-uat-*\n",
    );
    fs.writeFileSync(
      path.join(repo, "playwright.config.ts"),
      `export default { testDir: '.', testMatch: 'acceptance.spec.ts', timeout: 15000, use: {baseURL:process.env.UAT_BASE_URL,channel: process.env.IAF_TEST_BROWSER_CHANNEL || undefined} };`,
    );
    fs.writeFileSync(
      path.join(repo, "acceptance.spec.ts"),
      `import {test,expect} from '@playwright/test'; import fs from 'node:fs'; test('浏览器展示构建产物',async({page})=>{await page.goto('/');await expect(page.getByRole('heading')).toHaveText('修复完成');});`,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", "初始化");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    const config = transformEnvToConfig(
      envSchema.parse({
        GITHUB_API_URL: "http://localhost:9",
        GITHUB_TOKEN: "mock",
        GITHUB_REPOSITORY: "demo/repo",
        PROJECT_WORK_DIR: repo,
        BASE_BRANCH: "main",
        WORKTREE_BASE_DIR: path.join(dir, "worktrees"),
        PREVIEW_ENABLED: "true",
        PREVIEW_BACKEND_COMMAND: '"' + process.execPath + '" server.mjs {port}',
        PREVIEW_FRONTEND_COMMAND:
          '"' + process.execPath + '" server.mjs {port}',
        E2E_UI_ENABLED: "true",
      }),
      path.resolve("src"),
    );
    const pipeline = buildPlanModePipeline({ e2eEnabled: true });
    registerPipeline(pipeline);
    const tracker = new IssueTracker(
      process.env.DATA_DIR!,
      new Map([[pipeline.mode, createLifecycleManager(pipeline)]]),
    );
    const issue: GitHubIssue = {
      id: 101,
      number: 1,
      title: "实现页面",
      description: "显示修复完成标题",
      labels: ["auto-finish"],
      state: "open",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author: { username: "demo", name: "demo" },
    };
    const platform = new GitHubClient(config.github),
      notes: {
        id: number;
        body: string;
        author: { name: string; username: string };
        created_at: string;
      }[] = [];
    vi.spyOn(platform, "updateIssueLabels").mockResolvedValue(undefined);
    vi.spyOn(platform, "createIssueNote").mockImplementation(
      async (_id, body) => {
        notes.push({
          id: notes.length + 1,
          body,
          author: { name: "bot", username: "bot" },
          created_at: new Date().toISOString(),
        });
      },
    );
    vi.spyOn(platform, "listIssueNotes").mockImplementation(async () => notes);
    vi.spyOn(platform, "findPullRequestByBranch").mockResolvedValue(null);
    const createPr = vi
      .spyOn(platform, "createPullRequest")
      .mockRejectedValueOnce(new Error("模拟平台不可用"))
      .mockResolvedValue({
        id: 5,
        number: 5,
        title: "实现页面",
        html_url: "http://example.test/pr/5",
        state: "open",
      });
    const calls: RunOptions[] = [];
    let builds = 0,
      verifies = 0;
    const plan =
      "# 实施计划\n\n## 目标\n实现简单页面，并覆盖测试和浏览器验收，错误时可以重试。\n\n## 实施待办\n- [ ] 创建页面\n- [ ] 执行验证并修复\n- [ ] 浏览器检查\n";
    const runner: AIRunner = {
      killAll() {},
      killByWorkDir() {
        return 0;
      },
      async run(options) {
        calls.push(options);
        const planDir = path.join(options.workDir, ".claude-plan", "issue-1");
        fs.mkdirSync(planDir, { recursive: true });
        if (options.mode === "plan")
          return {
            success: true,
            output:
              plan +
              (calls.length > 1 ? "\n根据反馈增加错误处理和边界测试。" : ""),
            exitCode: 0,
          };
        if (options.phaseName === "build") {
          builds++;
          fs.writeFileSync(
            path.join(options.workDir, "index.html"),
            `<h1>${builds === 1 ? "待修复" : "修复完成"}</h1>`,
          );
          fs.writeFileSync(
            path.join(planDir, "01-plan.md"),
            plan.replaceAll("[ ]", "[x]"),
          );
          return { success: true, output: "已实现页面并检查待办", exitCode: 0 };
        }
        if (options.phaseName === "verify") {
          verifies++;
          fs.writeFileSync(
            path.join(planDir, "02-verify-report.md"),
            verifies === 1
              ? "# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 失败\n\n## 失败原因\n标题不符合验收标准，需要修复页面。\n"
              : "# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 通过\nTodolist: 全部完成\n\n## 总结\n所有检查通过，页面标题符合要求。\n",
          );
          return { success: true, output: "已运行验证并生成报告", exitCode: 0 };
        }
        throw new Error("意外 AI 调用：" + options.phaseName);
      },
    };
    const orchestrator = new PipelineOrchestrator(
      config,
      platform,
      new GitOperations(repo),
      runner,
      tracker,
      new SupplementStore(process.env.DATA_DIR!),
      new AsyncMutex(),
    );
    const diaryStore = new DiaryStore(
        path.join(process.env.DATA_DIR!, "distill"),
      ),
      collector = new DiaryCollector({
        tracker,
        diaryStore,
        createPlanPersistence: (number) =>
          new PlanPersistence(
            path.join(config.project.worktreeBaseDir, "issue-" + number),
            number,
          ),
      });
    collector.start();
    try {
      await Promise.all([
        orchestrator.processIssue(issue),
        orchestrator.processIssue(issue),
      ]);
      expect(calls.length).toBe(1);
      expect(tracker.get(1)?.state).toBe(IssueState.PhaseWaiting);
      await orchestrator.applyGateAction(1, {
        action: "reject",
        feedback: "增加错误处理和边界测试",
      });
      await orchestrator.processIssue(issue);
      expect(calls.at(-1)?.prompt).toContain("增加错误处理");
      expect(tracker.get(1)?.state).toBe(IssueState.PhaseWaiting);
      await orchestrator.applyGateAction(1, { action: "approve" });
      await expect(orchestrator.processIssue(issue)).rejects.toThrow(
        "创建合并请求失败",
      );
      expect(tracker.get(1)?.phaseProgress?.uat?.status).toBe("completed");
      expect(builds).toBe(2);
      expect(tracker.get(1)?.deliveryPending).toBe(true);
      const callsBeforeRetry = calls.length;
      tracker.resetForRetry(1);
      await orchestrator.processIssue(issue);
      expect(calls.length).toBe(callsBeforeRetry);
      expect(tracker.get(1)?.state).toBe(IssueState.Completed);
      expect(createPr).toHaveBeenCalledTimes(2);
      expect(notes.some((n) => n.body.includes("iaf-delivery:1:"))).toBe(true);
      await collector.collectDiary(1, "completed");
      expect(
        diaryStore.getByIssueIid(1).filter((d) => d.outcome === "completed"),
      ).toHaveLength(1);
      const reloaded = new IssueTracker(
        process.env.DATA_DIR!,
        new Map([[pipeline.mode, createLifecycleManager(pipeline)]]),
      );
      expect(summarizeTasks(reloaded.getAll(), "all")).toEqual(
        summarizeTasks(tracker.getAll(), "all"),
      );
      expect(summarizeTasks(reloaded.getAll(), "all").successRate).toBe(1);
      expect(summarizeTasks(reloaded.getAll(), "all").interventions).toBe(2);
      expect(
        git(
          repo,
          "show",
          "origin/" + tracker.get(1)!.branchName + ":index.html",
        ),
      ).toContain("修复完成");
    } finally {
      collector.stop();
      orchestrator.getDevServerManager().stopAll();
    }
  }, 180000);
});
