import { buildPlanModePipeline } from '../../../src/pipeline/PipelineMetadata.js';
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DagPhaseRunner } from '../../../src/orchestrator/DagPhaseRunner.js';
import { TaskGraphExecutor } from '../../../src/dag/TaskGraphExecutor.js';
import { GitOperations } from '../../../src/git/GitOperations.js';
import { PlanPersistence } from '../../../src/persistence/PlanPersistence.js';
import { AsyncMutex } from '../../../src/utils/AsyncMutex.js';
import { configuredCallPolicy } from '../../../src/ai-runner/CallPolicy.js';
import type { AIRunner, RunOptions, RunResult } from '../../../src/ai-runner/AIRunner.js';
import { createMockOrchestratorDeps, createTestConfig } from '../../helpers/mock-factories.js';
import { graphFixture, graphDeps, task } from '../../helpers/dag-repository.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const success = { success: true, output: '完成', exitCode: 0 };
function setup(action: (options: RunOptions) => Promise<RunResult>, uat = false) {
  const f = graphFixture([task('a')], buildPlanModePipeline({ e2eEnabled: uat })); directories.push(f.directory);
  const config = createTestConfig();
  config.e2e.enabled = uat;
  Object.assign(config.project, { gitRootDir: f.repo, workDir: f.integration, worktreeBaseDir: f.worktrees, projectSubDir: '' });
  Object.assign(config.ai, { phaseTimeoutMs: 3210, idleTimeoutMs: 987, timeoutGraceMs: 654, timeoutExtensionMs: 432, timeoutMaxExtensions: 2, model: 'test-policy' });
  const calls: RunOptions[] = [];
  const ai: AIRunner = { killAll() {}, killByWorkDir() { return 0; }, async run(options) { calls.push(options); return action(options); } };
  const deps = createMockOrchestratorDeps({ config, tracker: f.tracker, aiRunner: ai, mainGitMutex: new AsyncMutex() });
  const runner = new DagPhaseRunner(deps, new GitOperations(f.integration), new PlanPersistence(f.integration, 1, f.data, f.tracker));
  const run = () => runner.run({ id: 'build', label: '构建', kind: 'ai' }, { issueIid: 1, demand: f.tracker.get(1)!.demandSpec, workDir: f.integration, branchName: 'iaf-1' });
  return { f, config, calls, ai, run };
}

it('真实 build 经过任务图，完整批准计划和超时策略进入受管理调用', async () => {
  const h = setup(async options => { fs.writeFileSync(path.join(options.workDir, 'feature.txt'), '实现'); return success; });
  expect((await h.run()).kind).toBe('completed');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({ ...configuredCallPolicy(h.config.ai), mode: 'agent', phaseName: 'build' });
  expect(h.calls[0].prompt).toContain(JSON.stringify(h.f.tracker.store.readPlan(1, 1)));
  expect(h.f.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
  expect(h.f.tracker.get(1)!.run!.candidateCommit).toBeTruthy();
});

it('整批任务无有效代码变化时停止交付', async () => {
  const h = setup(async () => success);
  const result = await h.run();
  expect(result).toMatchObject({ kind: 'failed', error: { retryable: 'hard-no-auto' } });
  if (result.kind === 'failed') expect(result.error.message).toContain('没有有效仓库内容变化');
});

it('AI 最终失败不得生成候选提交', async () => {
  const h = setup(async () => ({ ...success, success: false, errorMessage: '模型失败' }));
  expect(await h.run()).toMatchObject({ kind: 'failed', error: { message: '模型失败' } });
  expect(h.f.tracker.get(1)!.run!.candidateCommit).toBeUndefined();
});

it('集成修复使用持久化报告及完整计划，不重新运行已合并任务', async () => {
  const h = setup(async options => { fs.writeFileSync(path.join(options.workDir, 'feature.txt'), String(h.calls.length)); return success; });
  await new TaskGraphExecutor(graphDeps(h.f, h.ai)).execute();
  h.calls.length = 0;
  h.f.tracker.transaction(1, record => {
    record.run!.buildEntry = 'repair-integration';
    record.run!.repairRounds = 1;
    record.run!.repairs.push({ round: 1, source: 'verify', report: 'Lint failed / Test failed：完整诊断' });
  });
  expect((await h.run()).kind).toBe('completed');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({ ...configuredCallPolicy(h.config.ai), identity: { taskId: '$phase:build' } });
  expect(h.calls[0].prompt).toContain('Lint failed / Test failed：完整诊断');
  expect(h.calls[0].prompt).toContain(JSON.stringify(h.f.tracker.store.readPlan(1, 1)));
  expect(h.f.tracker.get(1)!.run!.tasks.a.attemptNo).toBe(1);
});

it('UAT 准备共享完整策略并接收批准的验收要求', async () => {
  const h = setup(async options => {
    fs.writeFileSync(path.join(options.workDir, options.identity!.taskId === 'a' ? 'feature.txt' : 'playwright.config.ts'), '准备完成');
    return success;
  }, true);
  expect((await h.run()).kind).toBe('completed');
  const preparation = h.calls.find(call => call.identity!.taskId === '$phase:build')!;
  expect(preparation).toMatchObject({ ...configuredCallPolicy(h.config.ai), mode: 'agent' });
  expect(preparation.prompt).toContain('process.env.UAT_BASE_URL');
  expect(preparation.prompt).toContain(JSON.stringify(h.f.tracker.store.readPlan(1, 1)));
});
