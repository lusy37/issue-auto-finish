import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { TrackerStateStore } from '../../src/orchestrator/TrackerStateStore.js';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { CodexRunner } from '../../src/ai-runner/CodexRunner.js';
import { createTestConfig, createMockGitOperations, createMockAIRunner } from '../helpers/mock-factories.js';
import { createLifecycleManager, getPipelineDef } from '../../src/pipeline/PipelineDefinition.js';
import type { AIRunner } from '../../src/ai-runner/AIRunner.js';

let dir: string;
let plan: PlanPersistence;
let tracker: IssueTracker;
const demand = { demandId: 'gh-42', title: '恢复测试', description: '生成计划', sourceRef: { source: 'github-issue' as const, externalId: '42', displayId: '42' }, createdAt: new Date().toISOString() };
const ctx = { demand, branchName: 'feat/42' };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
  const def = getPipelineDef('plan-mode')!;
  tracker = new IssueTracker(dir, new Map([['plan-mode', createLifecycleManager(def)]]));
  tracker.create({ demandSpec: demand, state: IssueState.PhaseRunning, branchName: 'feat/42', currentPhase: 'plan', pipelineMode: 'plan-mode' });
  tracker.initPhaseProgress(42, def);
  plan = new PlanPersistence(dir, 42);
  plan.writeProgress(plan.createInitialProgress(42, demand.title, 'feat/42', def));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function runner() {
  return { ...createMockAIRunner(), canResumeSession: CodexRunner.prototype.canResumeSession };
}
function phase(ai: AIRunner) {
  return new PlanPhase(ai, createMockGitOperations() as never, plan, createTestConfig());
}

it('中断后重建状态适配器，实际从进度文件恢复 SDK 会话', async () => {
  const ai = runner();
  ai.run.mockImplementationOnce(async options => {
    options.onStreamEvent?.({ type: 'system', content: '会话启动', sessionId: 'codex:thread-42', timestamp: new Date().toISOString() });
    throw new Error('模拟进程中断');
  });
  new TrackerStateStore(tracker, plan).transitionToRunning(42, 'plan', new Date().toISOString());
  await expect(phase(ai).run(ctx)).rejects.toThrow('模拟进程中断');
  expect(plan.readProgress()?.phases.plan).toMatchObject({ status: 'in_progress', sessionId: 'codex:thread-42' });

  const resumed = runner();
  resumed.run.mockResolvedValue({ success: true, output: structuredPlanOutput('完整实施计划。'.repeat(12)), sessionId: 'codex:thread-42', exitCode: 0 });
  new TrackerStateStore(tracker, plan).transitionToRunning(42, 'plan', new Date().toISOString());
  expect((await phase(resumed).run(ctx)).kind).toBe('completed');
  expect(resumed.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'codex:thread-42', continueSession: true }));
});

it.each(['中断', '驳回'])('%s会话标识无效时，使用完整计划上下文重新开始', async reason => {
  plan.updatePhaseProgress('plan', reason === '中断' ? 'failed' : 'completed');
  plan.updatePhaseSessionId('plan', 'invalid-session-id');
  if (reason === '驳回') plan.writeReviewFeedback('增加测试', '上一轮完整计划', 'invalid-session-id');
  const ai = runner();
  ai.run.mockResolvedValue({ success: true, output: structuredPlanOutput('完整实施计划。'.repeat(12)), sessionId: 'codex:new-thread', exitCode: 0 });
  await phase(ai).run(ctx);
  expect(ai.run.mock.calls[0][0].continueSession).toBeUndefined();
  if (reason === '驳回') expect(ai.run.mock.calls[0][0].prompt).toContain('上一轮完整计划');
});

it('已完成阶段重新执行时清理旧会话，避免吞掉新一轮修复要求', () => {
  plan.updatePhaseProgress('plan', 'completed');
  plan.updatePhaseSessionId('plan', 'codex:completed-thread');
  new TrackerStateStore(tracker, plan).transitionToRunning(42, 'plan', new Date().toISOString());
  expect(plan.getPhaseSessionId('plan')).toBeUndefined();
});
