vi.mock('../../src/verify/VerificationCommands.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/verify/VerificationCommands.js')>();
  return { ...original, runVerificationCommands: vi.fn(async options => {
    const { verificationChecks } = await import('../helpers/verify-result.js');
    return verificationChecks({ commands: options.commands });
  }) };
});

import { DagPhaseRunner } from '../../src/orchestrator/DagPhaseRunner.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import { graphFixture, task } from '../helpers/dag-repository.js';
import { createMockOrchestratorDeps } from '../helpers/mock-factories.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeStore } from '../../src/knowledge/KnowledgeStore.js';
import { KNOWLEDGE_DEFAULTS } from '../../src/knowledge/KnowledgeDefaults.js';
import { loadKnowledge, resetKnowledgeCache } from '../../src/knowledge/KnowledgeLoader.js';
import { readProjectProfile, writeProjectProfile } from '../../src/knowledge/ProjectProfile.js';
import { DiaryStore } from '../../src/distill/DiaryStore.js';
import { VersionStore } from '../../src/distill/VersionStore.js';
import { MemoryDistiller } from '../../src/distill/MemoryDistiller.js';
import { AgentRuleDistiller } from '../../src/distill/AgentRuleDistiller.js';
import { DistillScheduler } from '../../src/distill/DistillScheduler.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { createApp } from '../../src/web/createApp.js';
import { createDistillRouter } from '../../src/web/routes/distill.js';
import { createTestConfig, createMockGitOperations } from '../helpers/mock-factories.js';
import type { AIRunner, RunOptions } from '../../src/ai-runner/AIRunner.js';
import { verifyAgentOutput } from '../helpers/verify-result.js';

let dir: string;
const graphDirectories: string[] = [];
beforeEach(() => {
  const root = path.resolve('.iaf-mini/repair-tests');
  fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, '知识开关 '));
  vi.stubEnv('DATA_DIR', dir);
  resetKnowledgeCache();
});
afterEach(() => {
  resetKnowledgeCache();
  for (const directory of graphDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.each([
  { knowledge: true, distill: true }, { knowledge: true, distill: false },
  { knowledge: false, distill: true }, { knowledge: false, distill: false },
])('知识引用=$knowledge，经验蒸馏=$distill：两项独立控制实际入口', async flags => {
  const config = createTestConfig();
  config.knowledge.enabled = flags.knowledge;
  config.distill.enabled = flags.distill;
  const profile = structuredClone(KNOWLEDGE_DEFAULTS);
  profile.businessContext.purpose = '附加业务知识标记';
  profile.agentKnowledge.conventions = ['附加约定标记'];
  profile.codeStyle.additionalRules = ['附加代码规则标记'];
  profile.knownIssues = [{ description: '历史问题标记', advice: '历史建议标记' }];
  profile.toolchain.buildCommand = 'pnpm build:required';
  profile.toolchain.testCommand = 'pnpm test:required';
  profile.toolchain.testFilesCommand = 'pnpm test:required -- {files}';
  const profileFile = path.join(dir, 'custom-profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(profile));
  loadKnowledge(profileFile);
  const knowledgeStore = new KnowledgeStore(path.join(dir, 'knowledge'));
  knowledgeStore.create({ type: 'custom', title: '自定义资料', content: '附加自定义知识标记', tags: [] });
  knowledgeStore.create({ type: 'agent-rule', title: '历史蒸馏规则', content: JSON.stringify({ content: '旧经验规则标记', deprecated: false }), tags: ['enabled'] });
  const calls: RunOptions[] = [];
  const plan = new PlanPersistence(dir, 1);
  const runner: AIRunner = {
    killAll() {}, killByWorkDir() { return 0; },
    async run(options) {
      calls.push(options);
      if (options.phaseName === 'build') fs.writeFileSync(path.join(options.workDir, 'feature.txt'), '代码变化');
      return { success: true, exitCode: 0, output: options.phaseName === 'verify'
        ? verifyAgentOutput({ commands: { build: 'pnpm build:required', test: 'pnpm test:required' }, reportMarkdown: '# 验证报告\n\nLint、Build、Test 均已执行并通过，本次代码检查和关联测试满足进入下一阶段的条件。' })
        : JSON.stringify({ actions: [] }) };
    },
  };
  const git = createMockGitOperations();
  git.hasChanges.mockResolvedValue(true);
  const ctx: PhaseContext = {
    demand: { demandId: 'gh-1', title: '开发页面', description: '实现需求', createdAt: new Date().toISOString(), sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' } },
    branchName: 'feat/issue-1', pipelineMode: 'plan-mode',
  };
  for (const Phase of [VerifyPhase]) {
    expect((await new Phase(runner, git as never, plan, config).run(ctx)).kind).toBe('completed');
  }
  const f = graphFixture([task('a')]); graphDirectories.push(f.directory);
  Object.assign(config.project, { gitRootDir: f.repo, workDir: f.integration, worktreeBaseDir: f.worktrees, projectSubDir: '' });
  const native = new DagPhaseRunner(createMockOrchestratorDeps({ config, tracker: f.tracker, aiRunner: runner, mainGitMutex: new AsyncMutex() }), new GitOperations(f.integration), new PlanPersistence(f.integration, 1, f.data, f.tracker));
  expect((await native.run({ id: 'build', label: '构建', kind: 'ai' }, { issueIid: 1, demand: f.tracker.get(1)!.demandSpec, workDir: f.integration, branchName: 'iaf-1' })).kind).toBe('completed');
  const prompt = calls.map(call => call.prompt).join('\n');
  for (const marker of ['附加业务知识标记', '附加约定标记', '附加代码规则标记', '历史问题标记', '旧经验规则标记', '附加自定义知识标记']) {
    expect(prompt.includes(marker), marker).toBe(flags.knowledge);
  }
  expect(prompt).toContain('pnpm build:required');
  expect(prompt).toContain('pnpm test:required');
  // 开关关闭也可维护项目资料和已有知识，读写仍落在自定义来源。
  writeProjectProfile({ ...readProjectProfile(), description: '可维护的项目说明' });
  expect(JSON.parse(fs.readFileSync(profileFile, 'utf8')).businessContext.purpose).toBe('可维护的项目说明');
  expect(knowledgeStore.list()).toHaveLength(2);

  const distillDir = path.join(dir, 'distill');
  const diaryStore = new DiaryStore(distillDir);
  const versionStore = new VersionStore(distillDir);
  const now = new Date().toISOString();
  diaryStore.create({
    id: 'd1', issueIid: 1, issueTitle: '测试', branchName: 'feat/issue-1', pipelineMode: 'plan-mode', outcome: 'completed',
    timing: { totalDurationMs: 100, phaseTimings: [], startedAt: now, finishedAt: now },
    humanInterventions: [], artifactSummary: '测试摘要', distilled: false, createdAt: now,
  });
  const distillerDeps = { aiRunner: runner, diaryStore, knowledgeStore, versionStore, workDir: dir, aiPolicy: { timeoutMs: 1000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' } };
  const scheduler = new DistillScheduler({
    enabled: flags.distill, diaryStore, knowledgeStore,
    memoryDistiller: new MemoryDistiller({ ...distillerDeps, minDiariesForDistill: 1 }),
    agentRuleDistiller: new AgentRuleDistiller({ ...distillerDeps, confidenceThreshold: 0.2 }),
  }, distillDir);
  calls.length = 0;
  const server = createApp(dir, [createDistillRouter({ config, diaryStore, distillScheduler: scheduler })]).listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('服务未启动');
    const base = `http://127.0.0.1:${address.port}/api/distill`;
    if (!flags.distill) {
      await expect(scheduler.runDistill()).rejects.toThrow('经验蒸馏已关闭');
      await expect(scheduler.runDistill({ force: true })).rejects.toThrow('经验蒸馏已关闭');
    }
    const response = await fetch(base + '/run', { method: 'POST' });
    expect(response.status, await response.text()).toBe(flags.distill ? 200 : 400);
    expect(calls.length > 0).toBe(flags.distill);
    expect((await (await fetch(base + '/status')).json()).status.enabled).toBe(flags.distill);
    expect((await (await fetch(base + '/diaries')).json()).total).toBe(1);
    if (!flags.distill) expect(scheduler.getStatus().runs).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
