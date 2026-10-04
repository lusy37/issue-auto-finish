import type { Config } from '../../src/config.js';
import { suspendAtReview } from '../helpers/native-review.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { it, expect, vi } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { envSchema, transformEnvToConfig } from "../../src/config-schema.js";
import { IssueTracker } from "../../src/tracker/IssueTracker.js";
import {
  buildPlanModePipeline,
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
import { UatResultStore } from '../../src/e2e/UatResultStore.js';
import { resolveTestBrowserChannel } from '../helpers/playwright-browser.js';

it("真实 Native 工作台：五个入口、草稿生成、任务详情与 UAT 报告截图", async () => {
  const browserChannel = resolveTestBrowserChannel();
  const root = path.resolve(".iaf-mini/browser-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "工作台 "));
  vi.stubEnv("DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("IAF_CONFIG_PATH", path.join(dir, ".env"));
  const config: Config = transformEnvToConfig(
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
  const tracker = new IssueTracker(
    process.env.DATA_DIR!,
    pipeline,
  );
  tracker.create({
    lifecycle: { kind: "waiting", phase: "review", planRevision: 1 },
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
  knowledgeStore.create({
    id: 'experience-1',
    type: 'memory',
    title: '真实执行经验',
    content: JSON.stringify({
      id: 'experience-1', content: '来自知识存储的验收经验', confidence: 0.8, evidence: ['diary-1'],
    }),
    tags: ['验收'],
  });
  knowledgeStore.create({
    id: 'rule-1',
    type: 'agent-rule',
    title: '交付前检查',
    content: JSON.stringify({ id: 'rule-1', content: '交付前运行构建与测试', deprecated: false }),
    tags: ['构建'],
  });
  diaryStore.create({
    id: 'diary-1',
    issueIid: 1,
    issueTitle: '工作台验收任务',
    branchName: 'feat/issue-1',
    pipelineMode: 'plan-mode',
    outcome: 'completed',
    timing: {
      totalDurationMs: 1200,
      phaseTimings: [],
      startedAt: new Date(Date.now() - 1200).toISOString(),
      finishedAt: new Date().toISOString(),
    },
    humanInterventions: [],
    artifactSummary: '自动采集的经验记录',
    distilled: false,
    createdAt: new Date().toISOString(),
  });
  const distillScheduler = new DistillScheduler({
    diaryStore,
    knowledgeStore,
    memoryDistiller: new MemoryDistiller({
      aiRunner: runner,
      diaryStore,
      knowledgeStore,
      versionStore,
      workDir: dir,
      aiPolicy: { timeoutMs: 1000 },
      minDiariesForDistill: 1,
    }),
    agentRuleDistiller: new AgentRuleDistiller({
      aiRunner: runner,
      knowledgeStore,
      versionStore,
      workDir: dir,
      aiPolicy: { timeoutMs: 1000 },
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
    channel: browserChannel,
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
    await page.goto(`${base}/#/workbench`);
    await browserExpect(page.locator('.prototype-shell')).toBeVisible();
    await browserExpect(page.locator('.prototype-preview-strip')).toHaveCount(0);
    await browserExpect(page.getByRole('heading', { name: '任务工作台' })).toBeVisible();
    await browserExpect(page.locator('.prototype-sidebar .n-menu-item-content')).toHaveCount(4);
    await browserExpect(page.locator('.prototype-repo-card')).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: '快速查找' })).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: '切换主题' })).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: '查看待处理事项' })).toHaveCount(0);
    await browserExpect(page.locator('.prototype-side-tip')).toHaveCount(0);
    await browserExpect(page.getByText('工作台验收任务', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('等待审核', { exact: true }).first()).toBeVisible();

    const selectMenu = async (label: string) => {
      await page.locator('.prototype-sidebar .n-menu-item-content').filter({ hasText: label }).click();
    };
    await selectMenu('知识与经验');
    await browserExpect(page.getByRole('heading', { name: '知识与经验' })).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '立即执行蒸馏', exact: true })).toBeVisible();
    await browserExpect(page.getByRole('tab', { name: /项目资料/ })).toHaveAttribute('aria-selected', 'true');
    await browserExpect(page.getByRole('heading', { name: '项目资料', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /经验日志/ }).click();
    await browserExpect(page.getByRole('heading', { name: /经验日志/ })).toBeVisible();
    await browserExpect(page.getByText('自动采集的经验记录', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /Memory 记忆/ }).click();
    await browserExpect(page.getByRole('heading', { name: /Memory 记忆/ })).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: '真实执行经验' })).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: '项目开发约定' })).toHaveCount(0);
    await page.getByRole('button', { name: '阅读内容', exact: true }).first().click();
    await browserExpect(page.locator('.prototype-document-reading')).toHaveText('来自知识存储的验收经验');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /Agent Rule 规则/ }).click();
    await browserExpect(page.getByRole('heading', { name: /Agent Rule 规则/ })).toBeVisible();
    await page.getByRole('switch', { name: '启用规则 交付前检查' }).click();
    await browserExpect(page.getByRole('switch', { name: '停用规则 交付前检查' })).toBeChecked();
    await page.getByRole('tab', { name: /项目资料/ }).click();
    await page.getByRole('button', { name: '新增知识' }).first().click();
    await page.getByPlaceholder('例如：提交前必须运行的检查').fill('项目约定 A');
    await page.getByPlaceholder('记录可复用的规则或经验').fill('新任务先检查依赖');
    await page.getByRole('button', { name: '保存知识' }).click();
    await browserExpect(page.getByRole('heading', { name: '项目约定 A' })).toBeVisible();
    await page.getByLabel('搜索知识').fill('项目约定 A');
    await browserExpect(page.locator('.knowledge-workspace .prototype-document-card')).toHaveCount(1);
    await page.locator('.knowledge-workspace .prototype-document-card').getByRole('button', { name: '编辑' }).click();
    await page.getByPlaceholder('记录可复用的规则或经验').fill('新任务先检查依赖并运行测试');
    await page.getByRole('button', { name: '保存知识' }).click();
    await page.reload();
    await browserExpect(page.getByRole('heading', { name: '项目约定 A' })).toBeVisible();
    await page.getByRole('tab', { name: /Agent Rule 规则/ }).click();
    await browserExpect(page.getByRole('switch', { name: '停用规则 交付前检查' })).toBeChecked();
    await page.getByRole('tab', { name: /项目资料/ }).click();
    await page.getByLabel('搜索知识').fill('项目约定 A');
    await page.getByRole('button', { name: '阅读内容', exact: true }).click();
    await browserExpect(page.locator('.prototype-document-reading')).toHaveText('新任务先检查依赖并运行测试');
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await browserExpect(page.getByRole('heading', { name: '项目约定 A' })).toHaveCount(0);
    await browserExpect(page.getByText('没有匹配的知识或经验记录', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).first().click();
    await browserExpect(page.getByRole('heading', { name: '项目资料', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑资料' }).click();
    await page.getByRole('textbox', { name: '项目简介' }).fill('实际运行的项目资料');
    await page.getByRole('button', { name: '保存资料' }).click();
    await browserExpect(page.locator('.knowledge-profile-card p').first()).toHaveText('实际运行的项目资料');
    await page.reload();
    await browserExpect(page.locator('.knowledge-profile-card p').first()).toHaveText('实际运行的项目资料');
    await page.screenshot({ path: path.join(dir, '知识与经验-真实数据.png'), fullPage: true });

    await selectMenu('任务统计');
    await browserExpect(page.getByRole('heading', { name: '任务统计' })).toBeVisible();
    await browserExpect(page.locator('.prototype-analytics-metrics').getByText('总任务', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('待审核', { exact: true }).first()).toBeVisible();
    await browserExpect(page.getByRole('img', { name: /任务分布/ })).toBeVisible();

    await selectMenu('设置');
    await browserExpect(page.getByRole('heading', { name: '工作台设置' })).toBeVisible();
    await browserExpect(page.getByText('运行配置', { exact: true })).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
    await browserExpect(page.getByLabel('GitHub 仓库', { exact: true })).toBeVisible();
    await browserExpect(page.getByLabel('审核门', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('数据来自当前 LangGraph Native 服务端。', { exact: true })).toHaveCount(0);
    await browserExpect(page.getByText('已加载', { exact: true })).toHaveCount(0);

    await selectMenu('任务工作台');
    await page.getByText('工作台验收任务', { exact: true }).click();
    await browserExpect(page).toHaveURL(/#\/issue\/1$/);
    await browserExpect(page.getByRole('heading', { name: '工作台验收任务' })).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: '构建任务图' })).toBeVisible();
    await browserExpect(page.locator('.task-graph-panel .execution-eyebrow')).toHaveCount(0);
    await browserExpect(page.locator('.graph-legend')).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: '任务清单' })).toBeVisible();
    await browserExpect(page.locator('.prototype-workflow-panel .n-steps')).toBeVisible();
    await browserExpect(page.locator('.prototype-workflow-panel .n-step')).toHaveCount(6);
    await browserExpect.poll(async () => page.locator('.execution-surface .graph-viewport > .execution-graph').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const graphNode = page
      .getByRole('region', { name: '构建任务依赖图' })
      .getByRole('button', { name: /实现需求/ });
    await browserExpect(graphNode).toBeVisible();
    await graphNode.click();
    await browserExpect(graphNode).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '适配流程图' }).click();
    await browserExpect(page.getByRole('button', { name: '实施计划', exact: true }).first()).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '验收结果', exact: true })).toBeVisible();
    await page.locator('.prototype-detail-tabs button').filter({ hasText: '实施计划' }).click();
    await browserExpect(page.locator('.native-plan-panel')).toBeVisible();
    await browserExpect(page.locator('.native-plan-tasks .n-collapse-item')).toHaveCount(1);
    await browserExpect(page.getByText('让每一步都可核验', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '执行视图', exact: true }).click();

    // 达到上限后，从工作台进入人工介入区，并通过真实 API 恢复。
    tracker.transaction(1, record => {
      record.lifecycle = { kind: 'failed', phase: 'verify', retry: 'manual', error: { message: '集成修复额度已用完', retryable: 'hard-no-auto' } };
      record.run.retryUsed.verify = config.poll.maxRetries;
      record.run.repairRounds = 3;
    });
    await page.goto(`${base}/#/workbench`);
    await page.reload();
    await browserExpect(page.getByText('1 个任务需要人工介入', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '处理 #1 · 工作台验收任务' }).click();
    const intervention = page.locator('.native-intervention-panel');
    await browserExpect(intervention).toBeVisible();
    await browserExpect(intervention.getByText('自动重试次数已达上限，需要人工处理')).toBeVisible();
    await page.screenshot({ path: path.join(dir, '人工介入-重试耗尽.png'), fullPage: true });
    await intervention.getByRole('button', { name: '查看失败日志' }).click();
    await browserExpect(page.locator('.prototype-detail-tabs button.active')).toHaveText('完整日志');
    await intervention.getByRole('button', { name: '手动重试当前阶段' }).click();
    await browserExpect(intervention).toHaveCount(0);
    expect(tracker.get(1)!.lifecycle.kind).toBe('ready');
    expect(tracker.get(1)!.run.retryUsed.verify).toBe(config.poll.maxRetries);

    tracker.transaction(1, record => {
      record.lifecycle = { kind: 'paused', phase: 'build' };
    });
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(intervention).toBeVisible();
    await browserExpect(intervention.getByRole('button', { name: '继续执行' })).toBeVisible();
    await browserExpect.poll(() => intervention.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(dir, '人工介入-移动端.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await intervention.getByRole('button', { name: '继续执行' }).click();
    await browserExpect(intervention).toHaveCount(0);
    expect(tracker.get(1)!.lifecycle.kind).toBe('ready');

    fs.writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      `export default {testDir:'.',testMatch:'screen.spec.ts',use:{channel:process.env.IAF_TEST_BROWSER_CHANNEL || undefined}};`,
    );
    fs.writeFileSync(
      path.join(dir, 'screen.spec.ts'),
      `import {test,expect} from '@playwright/test';
test('实际截图',async({page},testInfo)=>{
  await page.setContent('<h1>验收通过</h1>');
  await expect(page.getByRole('heading')).toHaveText('验收通过');
  await testInfo.attach('iaf-visual',{body:await page.screenshot(),contentType:'image/png'});
  await testInfo.attach('iaf-visual-meta',{
    body:Buffer.from(JSON.stringify({
      caseId:'heading',sceneId:'page',viewport:page.viewportSize(),
      pageUrl:page.url(),acceptanceRefs:['plan:0'],
    })),contentType:'application/json',
  });
});`,
    );
    const result = await executeUat({
      issueIid: 1,
      workDir: dir,
      configFile: 'playwright.config.ts',
      browserChannel,
      baseUrl: base,
      timeoutMs: 60000,
    });
    expect(result.playwrightExitCode).toBe(0);
    expect(result.reportValid).toBe(true);
    expect(result.failedTests).toBe(0);
    expect(result.screenshots?.length).toBeGreaterThan(0);
    const store = new UatResultStore(process.env.DATA_DIR!);
    const running = store.createRunning({
      runId: result.runId, issueIid: 1, startedAt: result.startedAt,
      policy: { visualReviewEnabled: false, maxImages: 12, timeoutMs: 180000 },
      execution: {
        candidateCommit: 'browser-fixture', planRevision: tracker.get(1)!.run!.planRevision,
        planDigest: tracker.get(1)!.run!.planDigest!, buildGeneration: 0,
        dispatchId: 'browser-fixture', phaseAttemptNo: 1,
      },
    });
    // 独立机器执行器不签发阶段摘要，测试按正式持久化契约准备展示数据。
    const machineSummary = store.applyMachineResult(running, result);
    store.writeSummary(store.finalize(machineSummary, running.visualReview));
    tracker.transaction(1, record => {
      record.lifecycle = { kind: 'completed' };
      record.completedAt = new Date().toISOString();
    });
    tracker.updatePhaseProgress(1, 'uat', { status: 'completed' });
    await page.reload();
    await page.getByRole('button', { name: '验收结果', exact: true }).click();
    await browserExpect(page.getByRole('link', { name: '打开本次 HTML 报告' })).toBeVisible();
    await browserExpect(page.locator('img').first()).toBeVisible();
    expect((await page.request.get(base + `/api/uat/runs/${result.runId}/files/report/index.html`)).ok()).toBe(true);

    await page.goto(`${base}/#/workbench`);
    await browserExpect(page.getByText('工作台验收任务', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(dir, 'Native 工作台-有数据.png'), fullPage: true });
    expect(errors).toEqual([]);
    fs.writeFileSync(
      path.join(root, 'latest.json'),
      JSON.stringify({ directory: dir, screenshot: path.join(dir, 'Native 工作台-有数据.png'), uatRunId: result.runId }, null, 2),
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
