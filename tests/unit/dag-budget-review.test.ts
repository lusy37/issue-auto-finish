import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { newTracker } from '../helpers/dag-repository.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { IssueWorkflow } from '../../src/orchestrator/IssueWorkflow.js';
import { suspendAtReview } from '../helpers/native-review.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-budget-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function prepared() {
  const tracker = newTracker(directory);
  tracker.create({ state: IssueState.Pending, branchName: 'iaf-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '需求', description: '实现需求', createdAt: new Date().toISOString() } });
  return tracker;
}
describe('持久重试预算', () => {
  it.each([['hard',0], ['hard',1], ['soft',0], ['soft',1]] as const)('%s 失败时 MAX_RETRIES=%s 的首次执行和边界', async (retryable, retries) => {
    const tracker = prepared();
    const run = vi.fn().mockResolvedValue({ kind: 'failed', error: { message: '持续失败', retryable } });

    const context = { issueIid: 1, demand: tracker.get(1)!.demandSpec!, branchName: 'iaf-1', workDir: directory, pipelineMode: 'plan-mode' };
    await new IssueWorkflow({ tracker, number: 1, runner: { run }, context, maxRetries: retries, maxRepairs: 3 }).drive();
    expect(run).toHaveBeenCalledTimes(retries + 1);
    expect(tracker.get(1)!.run!.retryUsed.plan ?? 0).toBe(retries);
    expect(tracker.get(1)!.state).toBe(IssueState.Failed);
    expect(newTracker(directory).get(1)!.run!.retryUsed).toEqual(tracker.get(1)!.run!.retryUsed);
    tracker.resetForRetry(1);
    await new IssueWorkflow({ tracker, number: 1, runner: { run }, context, maxRetries: retries, maxRepairs: 3 }).drive();
    expect(run).toHaveBeenCalledTimes(retries + 2);
    expect(tracker.get(1)!.run!.retryUsed.plan ?? 0).toBe(retries);
  });
  it('完整重做保留 PR 身份，创建新构建轮次及预算，计划版本不倒退', () => {
    const tracker = prepared();
    for (let revision = 0; revision < 7; revision++) tracker.store.savePlan(1, JSON.parse(structuredPlanOutput()), tracker.get(1)!.run!.version);
    tracker.transaction(1, record => { record.run!.retryUsed.build = 3; record.run!.delivery = { repository: 'a/b', issueNumber: 1, sourceBranch: 'iaf-1', targetBranch: 'main', marker: 'marker', creation: 'confirmed', prNumber: 9 }; record.prUrl = 'https://github.com/a/b/pull/9'; });
    tracker.resetFull(1);
    const run = tracker.get(1)!.run!;
    expect(run.buildGeneration).toBe(1); expect(run.planRevision).toBe(7);
    expect(run.retryUsed).toEqual({}); expect(run.delivery?.prNumber).toBe(9);
    expect(tracker.get(1)!.prUrl).toContain('/9');
  });
});
describe('审核事务', () => {
  it.each(['gate-approved', 'gate-rejected'] as const)('过期 %s 不改变新计划，当前版本只能决定一次', async outcome => {
    const tracker = prepared();
    const plan = JSON.parse(structuredPlanOutput());
    tracker.store.savePlan(1, plan, tracker.get(1)!.run!.version);
    tracker.store.savePlan(1, plan, tracker.get(1)!.run!.version);
    tracker.updateState(1, IssueState.PhaseWaiting, { currentPhase: 'review' });
    await suspendAtReview(tracker, 1);
    const workflow = new IssueWorkflow({ tracker, number: 1, runner: { run: async () => { throw new Error('不能执行 AI'); } }, context: { issueIid: 1, demand: tracker.get(1)!.demandSpec, branchName: 'iaf-1', workDir: directory }, maxRetries: 0, maxRepairs: 0 });
    const action = outcome === 'gate-approved' ? 'approve' as const : 'reject' as const;
    const previous = tracker.get(1);
    await expect(workflow.resumeReview({ action, planRevision: 1, feedback: '补充错误处理' })).rejects.toThrow('版本');
    expect(tracker.get(1)).toEqual(previous);
    await workflow.resumeReview({ action, planRevision: 2, feedback: '补充错误处理' });
    expect(tracker.get(1)!.run!.review?.decision).toBe(outcome === 'gate-approved' ? 'approved' : 'rejected');
    await expect(workflow.resumeReview({ action, planRevision: 2, feedback: '补充错误处理' })).rejects.toThrow('状态');
    if (outcome === 'gate-rejected') expect(tracker.get(1)!.run!.reviewHistory?.[0]).toMatchObject({ revision: 2, feedback: '补充错误处理' });
  });
});
