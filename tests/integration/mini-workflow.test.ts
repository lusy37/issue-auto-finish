import { structuredPlanOutput } from '../helpers/structured-plan.js';
import type { GitHubPullRequest } from '../../src/clients/GitHubClient.js';
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { envSchema, transformEnvToConfig } from "../../src/config-schema.js";
import { IssueTracker } from "../../src/tracker/IssueTracker.js";
import {
  buildPlanModePipeline,
} from "../../src/pipeline/PipelineMetadata.js";
import { IssueService } from "../../src/orchestrator/IssueService.js";
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
import { verifyAgentOutput } from '../helpers/verify-result.js';
import { resolveTestBrowserChannel } from '../helpers/playwright-browser.js';
import { runProcess } from '../../src/utils/process.js';

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
  it.each(['verify', 'uat'] as const)("驳回重做 → %s 失败修复 → 浏览器验收 → 交付恢复", async failurePhase => {
    const browserChannel = resolveTestBrowserChannel();
    const origin = path.join(dir, "origin.git"),
      repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(dir, "init", "--bare", origin);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Mini Demo");
    git(repo, "config", "user.email", "demo@example.test");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "README.md"), "# 演示项目\n");
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'verify-fixture', version: '1.0.0', scripts: {
      lint: 'node --check server.mjs', build: 'node --check server.mjs',
      test: 'node --test page.test.mjs',
    } }));
    // verify 场景由真实断言触发修复；uat 场景的页面标题由浏览器验证。
    fs.writeFileSync(path.join(repo, 'page.test.mjs'),
      "import assert from 'node:assert/strict';import fs from 'node:fs';import {test} from 'node:test';" +
      `test('页面具备预期结构',()=>{const page=fs.readFileSync('index.html','utf8');` +
      (failurePhase === 'verify' ? "assert.ok(page.includes('<h1>修复完成</h1>'));" : "assert.ok(page.startsWith('<h1>') && page.endsWith('</h1>'));") +
      '});');
    expect((await runProcess('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repo, timeoutMs: 30_000,
    })).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, "server.mjs"),
      // 启动时读取页面，模拟不会自动加载新代码的服务；修复后必须重启才能通过第二轮 UAT。
      "import http from 'node:http';import fs from 'node:fs';const page=fs.readFileSync('index.html');http.createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end(page);}).listen(Number(process.argv[2]),'127.0.0.1');",
    );
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      "node_modules/\n.iaf-uat-*\n",
    );
    fs.writeFileSync(
      path.join(repo, "playwright.config.ts"),
      // Windows CI 首次启动浏览器和自动截图也占用用例预算，避免环境耗时触发额外构建修复。
      `export default { testDir: '.', testMatch: 'acceptance.spec.ts', workers: 1, timeout: 60000, use: {baseURL:process.env.UAT_BASE_URL,channel: process.env.IAF_TEST_BROWSER_CHANNEL || undefined} };`,
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
        PLAYWRIGHT_CHANNEL: browserChannel ?? 'chromium',
        // 本组验证机器验收与交付恢复；视觉模型契约由视觉复核测试覆盖。
        E2E_VISUAL_REVIEW_ENABLED: "false",
      }),
      path.resolve("src"),
    );
    const pipeline = buildPlanModePipeline({ e2eEnabled: true });
    const tracker = new IssueTracker(
      process.env.DATA_DIR!,
      pipeline,
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
    let platformPr: GitHubPullRequest | undefined;
    vi.spyOn(platform, 'listPullRequests').mockImplementation(async () => platformPr ? [platformPr] : []);
    vi.spyOn(platform, 'getPullRequestDetail').mockImplementation(async () => ({ ...platformPr!, has_conflicts: false, merge_status: 'clean' }));
    const createPr = vi.spyOn(platform, 'createPullRequest').mockImplementation(async options => {
      platformPr = { id: 5, number: 5, title: options.title, html_url: 'http://example.test/pr/5', state: 'open',
        description: options.description, source_branch: options.sourceBranch, target_branch: options.targetBranch,
        source_repository: 'demo/repo', target_repository: 'demo/repo' };
      throw new Error('模拟 PR 已创建但响应丢失');
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
        if (options.phaseName === "plan")
          return {
            success: true,
            output:
              structuredPlanOutput(plan + (calls.length > 1 ? "\n根据反馈增加错误处理和边界测试。" : "")),
            exitCode: 0,
          };
        if (options.phaseName === "build") {
          builds++;
          fs.writeFileSync(
            path.join(options.workDir, "index.html"),
            `<h1>${builds === 1 ? "待修复" : "修复完成"}</h1>`,
          );
          return { success: true, output: "已实现页面并检查待办", exitCode: 0 };
        }
        if (options.phaseName === "verify") {
          verifies++;
          return { success: true, output: verifyAgentOutput({
            test: failurePhase === 'verify' && verifies === 1 ? 'failed' : 'passed',
            reportMarkdown: failurePhase === 'verify' && verifies === 1
              ? '# 验证报告\n\nTest 执行失败：标题不符合验收标准，需要回到 build 修复页面后重新验证。'
              : '# 验证报告\n\nLint、Build、Test 均已执行并通过，页面标题符合要求，可以进入后续浏览器验收。',
          }), exitCode: 0 };
        }
        throw new Error("意外 AI 调用：" + options.phaseName);
      },
    };
    const orchestrator = new IssueService(
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
            tracker.store.dataDir,
            tracker,
          ),
      });
    collector.start();
    try {
      await Promise.all([
        orchestrator.processIssue(issue),
        orchestrator.processIssue(issue),
      ]);
      expect(calls.length).toBe(1);
      expect(tracker.get(1)?.lifecycle).toMatchObject({ kind: 'waiting', phase: 'review' });
      await orchestrator.applyGateAction(1, {
        action: "reject",
        feedback: "增加错误处理和边界测试",
      }, tracker.get(1)!.run!.planRevision);
      await orchestrator.processIssue(issue);
      expect(calls.at(-1)?.prompt).toContain("增加错误处理");
      expect(tracker.get(1)?.lifecycle).toMatchObject({ kind: 'waiting', phase: 'review' });
      await orchestrator.applyGateAction(1, { action: "approve" }, tracker.get(1)!.run!.planRevision);
      await expect(orchestrator.processIssue(issue)).rejects.toThrow(
        "模拟 PR 已创建但响应丢失",
      );
      expect(tracker.get(1)?.phaseProgress?.uat?.status).toBe("completed");
      const accepted = tracker.get(1)!.run!;
      // 保留严格的修复次数断言，失败时直接显示触发额外修复的验收报告。
      expect(builds, "修复记录：\n" + JSON.stringify(accepted.repairs, null, 2)).toBe(2);
      expect(accepted.repairs).toMatchObject([{ source: failurePhase }]);
      expect(accepted.uat?.commit).toBe(accepted.candidateCommit);
      expect(accepted.verify?.commit).toBe(accepted.candidateCommit);
      expect(tracker.get(1)?.deliveryPending).toBe(true);
      const callsBeforeRetry = calls.length;
      tracker.resetForRetry(1);
      await orchestrator.processIssue(issue);
      expect(calls.length).toBe(callsBeforeRetry);
      expect(tracker.get(1)?.lifecycle.kind).toBe('completed');
      expect(createPr).toHaveBeenCalledTimes(1);
      expect(notes.some((n) => n.body.includes("iaf-delivery:1:"))).toBe(true);
      await collector.collectDiary(1, "completed");
      expect(
        diaryStore.getByIssueIid(1).filter((d) => d.outcome === "completed"),
      ).toHaveLength(1);
      const reloaded = new IssueTracker(
        process.env.DATA_DIR!,
        pipeline,
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
      await orchestrator.getDevServerManager().stopAllAndWait();
    }
  }, 300000);
});
