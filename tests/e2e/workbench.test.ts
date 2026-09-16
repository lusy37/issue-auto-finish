import { suspendAtReview } from '../helpers/native-review.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { it, expect, vi } from "vitest";
import { chromium, expect as browserExpect, type Request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { envSchema, transformEnvToConfig } from "../../src/config-schema.js";
import { IssueState } from "../../src/tracker/IssueState.js";
import { IssueTracker } from "../../src/tracker/IssueTracker.js";
import {
  buildPlanModePipeline,
  registerPipeline,
} from "../../src/pipeline/PipelineMetadata.js";
import { IssueService } from "../../src/orchestrator/IssueService.js";
import { GitHubClient } from "../../src/clients/GitHubClient.js";
import { GitOperations } from "../../src/git/GitOperations.js";
import { SupplementStore } from "../../src/supplement/SupplementStore.js";
import { PlanPersistence } from "../../src/persistence/PlanPersistence.js";
import { KnowledgeStore } from "../../src/knowledge/KnowledgeStore.js";
import { DiaryStore } from "../../src/distill/DiaryStore.js";
import { VersionStore } from "../../src/distill/VersionStore.js";
import { MemoryDistiller } from "../../src/distill/MemoryDistiller.js";
import { AgentRuleDistiller } from "../../src/distill/AgentRuleDistiller.js";
import { DistillScheduler } from "../../src/distill/DistillScheduler.js";
import { WebServer } from "../../src/web/WebServer.js";
import { AgentLogStore } from "../../src/web/AgentLogStore.js";
import type { AIRunner } from "../../src/ai-runner/AIRunner.js";
import { executeUat } from "../../src/e2e/PlaywrightRunner.js";

it("真实工作台：六个入口、草稿编辑创建、审核刷新、统计及报告截图", async () => {
  const root = path.resolve(".iaf-mini/browser-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "工作台 "));
  vi.stubEnv("DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("IAF_CONFIG_PATH", path.join(dir, ".env"));
  const config = transformEnvToConfig(
    envSchema.parse({
      GITHUB_API_URL: "http://127.0.0.1:9",
      GITHUB_TOKEN: "test",
      GITHUB_REPOSITORY: "demo/repo",
      PROJECT_WORK_DIR: dir,
      WORKTREE_BASE_DIR: path.join(dir, "worktrees"),
      PREVIEW_ENABLED: "false",
    }),
    path.resolve("src"),
  );
  (config.web as { port: number }).port = 0;
  const pipeline = buildPlanModePipeline({ e2eEnabled: true });
  registerPipeline(pipeline);
  const tracker = new IssueTracker(
    process.env.DATA_DIR!,
    new Map([[pipeline.mode, pipeline]]),
  );
  tracker.create({
    state: IssueState.PhaseWaiting,
    currentPhase: "review",
    branchName: "feat/issue-1",
    pipelineMode: "plan-mode",
    demandSpec: {
      demandId: "gh-1",
      sourceRef: {
        source: "github-issue",
        externalId: "101",
        displayId: "1",
      },
      title: "工作台验收任务",
      description: "验证完整界面",
      createdAt: new Date().toISOString(),
    },
  });
  tracker.store.savePlan(1, JSON.parse(structuredPlanOutput('工作台实施计划，覆盖错误处理和用户操作')), tracker.get(1)!.run!.version);
  tracker.initPhaseProgress(1, pipeline);
  tracker.updatePhaseProgress(1, "plan", { status: "completed" });
  tracker.updatePhaseProgress(1, "review", { status: "gate_waiting" });
  await suspendAtReview(tracker, 1);
  const plan = new PlanPersistence(
    path.join(config.project.worktreeBaseDir, "issue-1"),
    1,
  );
  plan.ensureDir();
  plan.writePlan(
    "# 工作台实施计划\n\n- [ ] 创建页面\n- [ ] 运行测试\n- [ ] 浏览器验收\n\n覆盖错误处理和用户操作。",
  );
  const platform = new GitHubClient(config.github);
  vi.spyOn(platform, "listIssueNotes").mockResolvedValue([]);
  vi.spyOn(platform, "createIssueNote").mockResolvedValue();
  vi.spyOn(platform, "listIssuesAdvanced").mockResolvedValue({
    issues: [],
    total: 0,
  });
  const createIssue = vi
    .spyOn(platform, "createIssue")
    .mockImplementation(async (title, description) => ({
      id: 102,
      number: 2,
      title, description, html_url: platform.repositoryUrl + "/issues/2",
      state: "open",
      labels: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author: { username: "demo", name: "demo" },
    }));
  const runner: AIRunner = {
    killAll() {},
    killByWorkDir() {
      return 0;
    },
    async run(options) {
      return {
        success: true,
        exitCode: 0,
        output: options.phaseName === 'draft'
          ? JSON.stringify({ title: '初始需求', description: '实现可展示的页面', acceptanceCriteria: '页面正常展示' })
          : JSON.stringify({ actions: [] }),
      };
    },
  };
  const knowledgeStore = new KnowledgeStore(
      path.join(process.env.DATA_DIR!, "knowledge"),
    ),
    diaryStore = new DiaryStore(path.join(process.env.DATA_DIR!, "distill")),
    versionStore = new VersionStore(
      path.join(process.env.DATA_DIR!, "distill"),
    );
  const distillScheduler = new DistillScheduler({
    diaryStore,
    knowledgeStore,
    memoryDistiller: new MemoryDistiller({
      aiRunner: runner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: dir,
      timeoutMs: 1000,
      minDiariesForDistill: 1,
    }),
    agentRuleDistiller: new AgentRuleDistiller({
      aiRunner: runner,
      knowledgeStore,
      versionStore,
      workDir: dir,
      timeoutMs: 1000,
      confidenceThreshold: 0.7,
    }),
  });
  const orchestrator = new IssueService(
    config,
    platform,
    new GitOperations(dir),
    runner,
    tracker,
    new SupplementStore(process.env.DATA_DIR!),
  );
  const web = new WebServer({
    config,
    tracker,
    github: platform,
    orchestrator,
    aiRunner: runner,
    knowledgeStore,
    diaryStore,
    distillScheduler,
    supplementStore: new SupplementStore(process.env.DATA_DIR!),
    agentLogStore: new AgentLogStore(process.env.DATA_DIR!),
  });
  const browser = await chromium.launch({
    channel: process.env.IAF_TEST_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await web.start();
    const base = `http://127.0.0.1:${web.getPort()}`;
    await page.goto(base);
    await browserExpect(
      page.getByRole("navigation", { name: "工作台导航" }).getByRole("button"),
    ).toHaveCount(6);
    await page.getByRole("button", { name: "需求草稿", exact: true }).click();
    await page.getByLabel("原始需求").fill("创建演示页面");
    await page.getByRole("button", { name: "生成草稿" }).click();
    await browserExpect(page.getByLabel("草稿标题")).toHaveValue("初始需求");
    await page.getByLabel("草稿标题").fill("编辑后的需求");
    await page.getByRole("button", { name: "确认创建一个 Issue" }).click();
    await browserExpect(
      page.getByRole("link", { name: "查看 Issue #2" }),
    ).toBeVisible();
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0]).toBe("编辑后的需求");
    await page.reload();
    await page.getByRole("button", { name: "需求草稿", exact: true }).click();
    await browserExpect(page.getByLabel("草稿标题")).toHaveValue(
      "编辑后的需求",
    );
    await page.getByRole("button", { name: "知识与经验", exact: true }).click();
    await page.getByText("项目说明、技术栈与测试命令", { exact: true }).click();
    await page.getByLabel("项目说明", { exact: true }).fill("这是演示工作台");
    await page.getByLabel("测试命令", { exact: true }).fill("npm test");
    await page.getByRole("button", { name: "保存项目上下文" }).click();
    await browserExpect(
      page.getByText("项目上下文已保存，后续任务将使用新配置。"),
    ).toBeVisible();
    await page.getByLabel("知识标题").fill("测试经验");
    await page.getByLabel("知识内容").fill("先验证失败再修复。");
    await page.getByRole("button", { name: "添加知识" }).click();
    await browserExpect(
      page.getByRole("heading", { name: "测试经验 custom" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "蒸馏", exact: true }).click();
    await page.getByRole("button", { name: "手动蒸馏" }).click();
    await browserExpect(page.locator("pre").first()).toContainText(
      "processedDiaries",
    );
    await page.getByRole("button", { name: "任务统计", exact: true }).click();
    await browserExpect(
      page.getByText("暂无数据", { exact: true }).first(),
    ).toBeVisible();
    await page.getByLabel("统计时间范围").selectOption("all");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const flowLabels = ["启用计划审核", "任务引用知识与经验", "启用经验蒸馏", "验证失败后自动修复"];
    for (const label of flowLabels) await browserExpect(page.getByRole("checkbox", { name: label, exact: true })).toBeChecked();
    await browserExpect(page.getByLabel("最大自动修复轮数")).toHaveValue("3");
    await page.getByLabel("最大自动修复轮数").fill("2");
    await browserExpect(page.getByLabel("全局 AI 并发额度（默认 4，范围 1～32）")).toHaveValue("4");
    await page.getByLabel("全局 AI 并发额度（默认 4，范围 1～32）").fill("2");
    for (const label of flowLabels) await page.getByRole("checkbox", { name: label, exact: true }).uncheck();
    await browserExpect(page.getByLabel("最大自动修复轮数")).toBeDisabled();
    await browserExpect(page.getByLabel("Codex 程序路径（留空使用内置程序，Windows 需为 .exe）")).toHaveValue(
      "",
    );
    await page.getByLabel("Codex 程序路径（留空使用内置程序，Windows 需为 .exe）").fill("C:\\中文 工具\\codex.exe");
    await page.getByRole("button", { name: "保存配置" }).click();
    await browserExpect(page.getByRole("status")).toContainText("配置已保存");
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    for (const label of flowLabels) await browserExpect(page.getByRole("checkbox", { name: label, exact: true })).not.toBeChecked();
    await browserExpect(page.getByLabel("最大自动修复轮数")).toHaveValue("2");
    // 页面回显已保存值，当前服务仍按启动配置运行，直到重启。
    const currentStatus = await (await page.request.get(base + "/api/system/status")).json();
    expect(currentStatus.config).toMatchObject({ reviewEnabled: true, knowledgeEnabled: true, distillEnabled: true, verifyFixLoopEnabled: true, verifyFixMaxIterations: 3 });
    await browserExpect(page.getByLabel("Codex 程序路径（留空使用内置程序，Windows 需为 .exe）")).toHaveValue(
      "C:\\中文 工具\\codex.exe",
    );
    const detailRequests: string[] = [];
    const trackDetailRequest = (request: Request) => {
      detailRequests.push(new URL(request.url()).pathname);
    };
    page.on("request", trackDetailRequest);
    await page.goto(base + "/detail?issue=1");
    await page.getByRole("button", { name: "内部任务", exact: true }).click();
    await browserExpect(page.getByText("implementation · 实现需求", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "审查", exact: true }).click();
    await browserExpect(
      page.getByRole("button", { name: "通过计划" }),
    ).toBeVisible();
    // 覆盖一个完整轮询周期，防止隐藏的首页重复初始化和查询状态。
    await page.waitForTimeout(11000);
    expect(detailRequests.filter((url) => url === "/api/system/status")).toHaveLength(2);
    expect(detailRequests.filter((url) => url === "/api/tasks")).toHaveLength(0);
    await page.getByRole("button", { name: "通过计划" }).click();
    await browserExpect
      .poll(() => tracker.get(1)?.state)
      .toBe(IssueState.PhaseApproved);
    await browserExpect(
      page.getByText("审查已通过", { exact: false }).first(),
    ).toBeVisible();
    await browserExpect(page.getByText("人工审核通过", { exact: true })).toBeVisible();
    // 审核事件更新详情时，也不应触发首页的任务列表刷新。
    expect(detailRequests.filter((url) => url === "/api/tasks")).toHaveLength(0);
    page.off("request", trackDetailRequest);
    const supplementFile = path.join(process.env.DATA_DIR!, 'supplements', '1.json');
    fs.mkdirSync(path.dirname(supplementFile), { recursive: true });
    fs.writeFileSync(supplementFile, '{损坏的补充资料');
    await page.reload();
    await page.getByRole("button", { name: "补充信息", exact: true }).click();
    await browserExpect(page.getByRole("alert")).toContainText("补充资料读取失败");
    await browserExpect(page.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
    expect(fs.readFileSync(supplementFile, 'utf8')).toBe('{损坏的补充资料');
    await page.reload();
    await page.getByRole("button", { name: "审查", exact: true }).click();
    await browserExpect(
      page.getByText("审查已通过", { exact: false }).first(),
    ).toBeVisible();
    fs.writeFileSync(
      path.join(dir, "playwright.config.ts"),
      `export default {testDir:'.',testMatch:'screen.spec.ts',use:{channel:process.env.IAF_TEST_BROWSER_CHANNEL || undefined}};`,
    );
    fs.writeFileSync(
      path.join(dir, "screen.spec.ts"),
      `import {test,expect} from '@playwright/test';test('实际截图',async({page})=>{await page.setContent('<h1>验收通过</h1>');await expect(page.getByRole('heading')).toHaveText('验收通过');});`,
    );
    const result = await executeUat({
      issueIid: 1,
      workDir: dir,
      configFile: "playwright.config.ts",
      baseUrl: base,
      timeoutMs: 60000,
    });
    expect(result.passed).toBe(true);
    expect(result.screenshots?.length).toBeGreaterThan(0);
    tracker.updateState(1, IssueState.Completed, {
      completedAt: new Date().toISOString(),
      uatRunId: result.runId,
    });
    tracker.updatePhaseProgress(1, "uat", { status: "completed" });
    await page.getByRole("button", { name: "E2E", exact: true }).click();
    await browserExpect(
      page.getByRole("link", { name: "打开本次 HTML 报告" }),
    ).toBeVisible();
    await browserExpect(page.locator("img").first()).toBeVisible();
    expect(
      (
        await page.request.get(
          base + `/api/uat/runs/${result.runId}/files/report/index.html`,
        )
      ).ok(),
    ).toBe(true);
    await page.goto(base);
    await page.getByRole("button", { name: "任务统计", exact: true }).click();
    await browserExpect(
      page.getByText("100.0%", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "工作台统计.png"),
      fullPage: true,
    });
    // 给测试服务注入关闭配置，覆盖关闭视图；真实设置的重启语义在上方单独验证。
    config.knowledge.enabled = false;
    config.distill.enabled = false;
    await page.reload();
    await page.getByRole("button", { name: "知识与经验", exact: true }).click();
    await browserExpect(page.getByText("任务知识引用已关闭。", { exact: false })).toBeVisible();
    await browserExpect(page.getByRole("heading", { name: "测试经验 custom" })).toBeVisible();
    await page.getByRole("button", { name: "蒸馏", exact: true }).click();
    await browserExpect(page.getByText("经验蒸馏已关闭", { exact: false })).toBeVisible();
    await browserExpect(page.getByRole("button", { name: "手动蒸馏" })).toBeDisabled();
    await browserExpect(page.locator("article").first()).toContainText("已完成");
    config.distill.enabled = true;
    await page.reload();
    await page.getByRole("button", { name: "蒸馏", exact: true }).click();
    await browserExpect(page.getByRole("button", { name: "手动蒸馏" })).toBeEnabled();
    await browserExpect(page.locator("article").first()).toContainText("已完成");
    expect(errors).toEqual([]);
    fs.writeFileSync(
      path.join(root, "latest.json"),
      JSON.stringify(
        {
          directory: dir,
          screenshot: path.join(dir, "工作台统计.png"),
          uatRunId: result.runId,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(dir, '失败现场.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(dir, '失败现场.json'), JSON.stringify({ url: page.url(), errors, body: await page.locator('body').innerText().catch(() => ''), issue: tracker.get(1) }, null, 2));
    throw error;
  } finally {
    await browser.close();
    web.stop();
    orchestrator.getDevServerManager().stopAll();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}, 180000);
