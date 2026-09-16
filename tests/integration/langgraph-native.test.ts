import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueWorkflow, type WorkflowOptions } from '../../src/orchestrator/IssueWorkflow.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { newTracker } from '../helpers/dag-repository.js';
import { structuredPlanOutput } from '../helpers/structured-plan.js';
import { buildPlanModePipeline } from '../../src/pipeline/PipelineMetadata.js';
import { IssueService } from '../../src/orchestrator/IssueService.js';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'langgraph-native-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(e2eEnabled = true) {
  let tracker = newTracker(directory);
  const demand = { demandId: 'gh-1', sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' }, title: '需求', description: '实施需求', createdAt: new Date().toISOString() };
  tracker.create({ state: IssueState.Pending, demandSpec: demand, branchName: 'iaf-1' });
  tracker.initPhaseProgress(1, buildPlanModePipeline({ e2eEnabled }));
  const calls: string[] = [];
  const runner: WorkflowOptions['runner'] = { run: async spec => {
    calls.push(spec.id);
    if (spec.id === 'plan') tracker.store.savePlan(1, JSON.parse(structuredPlanOutput()), tracker.get(1)!.run!.version);
    return { kind: 'completed', output: spec.id };
  } };
  const options = (): WorkflowOptions => ({ tracker, number: 1, runner, context: { issueIid: 1, demand, branchName: 'iaf-1', workDir: directory }, maxRetries: 1, maxRepairs: 2,
    deliver: async () => { calls.push('deliver'); tracker.updateState(1, IssueState.Completed, { deliveryPending: false }); },
  });
  return { calls, runner, options, workflow: () => new IssueWorkflow(options()), tracker: () => tracker,
    restart: () => { tracker = newTracker(directory); return new IssueWorkflow(options()); },
  };
}

async function projectBuildRetryWindow(f: ReturnType<typeof fixture>, retryUsed: number, attempts: number): Promise<void> {
  await f.workflow().drive();
  await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
  f.tracker().transaction(1, record => {
    record.state = IssueState.Failed;
    record.currentPhase = 'build';
    record.failedAtState = IssueState.PhaseRunning;
    record.lastError = '模拟已落盘失败';
    record.lastErrorRetryable = true;
    record.attempts = attempts;
    record.run!.retryUsed.build = retryUsed;
    record.orchestrationState = { kind: 'pipeline-failed', failedAt: 'build', retryable: 'auto', error: { message: record.lastError, retryable: 'hard' } };
    record.phaseProgress!.build = { status: 'failed', error: record.lastError };
  });
}

describe('LangGraph 原生持久化和人工介入', () => {
  it('审核中断跨实例保存；批准只恢复审核，下一次驱动只执行剩余节点', async () => {
    const f = fixture();
    await f.workflow().drive();
    expect(f.calls).toEqual(['plan']);
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseWaiting);
    const resumed = f.restart();
    const waiting = await resumed.getState();
    expect(waiting.tasks.flatMap(task => task.interrupts ?? [])).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ kind: 'review', planRevision: 1 }) }));
    await resumed.resumeReview({ action: 'approve', planRevision: 1 });
    expect(f.calls).toEqual(['plan']);
    expect(f.tracker().get(1)?.run?.review?.decision).toBe('approved');
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.state).toBe(IssueState.Completed);
    expect(f.tracker().get(1)?.phaseHistory?.every(entry => Number.isInteger(entry.attemptId) && entry.attemptId > 0)).toBe(true);
    const states = [];
    for await (const state of f.workflow().getStateHistory()) states.push(state);
    expect(states.length).toBeGreaterThan(5);
  });

  it('驳回绑定不可变版本，保留完整计划与反馈，重新规划后再次中断', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.restart().resumeReview({ action: 'reject', planRevision: 1, feedback: '增加错误处理' });
    expect(f.tracker().get(1)?.run?.reviewHistory?.[0]).toMatchObject({ revision: 1, feedback: '增加错误处理', planSnapshot: expect.stringContaining('验收标准') });
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'plan']);
    expect(f.tracker().get(1)?.run?.planRevision).toBe(2);
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseWaiting);
    await expect(f.workflow().resumeReview({ action: 'approve', planRevision: 1 })).rejects.toThrow('版本');
  });

  it('同一审核只能决定一次，重复并发批准不会推进两次', async () => {
    const f = fixture();
    await f.workflow().drive();
    const outcomes = await Promise.allSettled([f.workflow().resumeReview({ action: 'approve', planRevision: 1 }), f.workflow().resumeReview({ action: 'approve', planRevision: 1 })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.tracker().get(1)?.phaseHistory?.filter(entry => entry.outcome === 'gate-approved')).toHaveLength(1);
  });

  it('节点自动重试使用持久预算；耗尽后显式重试只增加一次执行', async () => {
    const f = fixture();
    const run = vi.spyOn(f.runner, 'run').mockResolvedValue({ kind: 'failed', error: { message: '暂时不可用', retryable: 'hard' } });
    await f.workflow().drive();
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.tracker().get(1)?.state).toBe(IssueState.Failed);
    expect(f.tracker().get(1)?.run?.retryUsed.plan).toBe(1);
    f.restart();
    f.tracker().resetForRetry(1);
    await f.workflow().drive();
    expect(run).toHaveBeenCalledTimes(3);
    expect(f.tracker().get(1)?.run?.retryUsed.plan).toBe(1);
  });

  it('失败已落盘但 retryPolicy 尚未预留时，重启补做且只扣一次预算', async () => {
    const f = fixture();
    await projectBuildRetryWindow(f, 0, 0);
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.run?.retryUsed.build).toBe(1);
    expect(f.tracker().get(1)?.state).toBe(IssueState.Completed);
  });

  it('retryPolicy 已预留最后一次预算但尚未执行时，重启可驱动且不重复扣减', async () => {
    const f = fixture();
    await projectBuildRetryWindow(f, 1, 0);
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.run?.retryUsed.build).toBe(1);
    expect(f.tracker().get(1)?.state).toBe(IssueState.Completed);
  });

  it('阶段成功后检查点写入失败，重启复用已提交结果，不重复调用 AI', async () => {
    const f = fixture();
    const workflow = f.workflow();
    const original = workflow.checkpointer.putWrites.bind(workflow.checkpointer);
    let interrupted = false;
    vi.spyOn(workflow.checkpointer, 'putWrites').mockImplementation(async (...args) => {
      if (!interrupted && f.tracker().get(1)?.phaseHistory?.some(entry => entry.phaseId === 'plan' && entry.outcome === 'completed')) { interrupted = true; throw new Error('模拟结果已保存后检查点写入中断'); }
      return original(...args);
    });
    await expect(workflow.drive()).rejects.toThrow('检查点');
    await f.restart().drive();
    expect(f.calls).toEqual(['plan']);
    expect(f.tracker().get(1)?.phaseHistory?.filter(entry => entry.phaseId === 'plan' && entry.outcome === 'completed')).toHaveLength(1);
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseWaiting);
  });

  it('拒绝读取旧聚合格式，不自动迁移或改写原文件', () => {
    const f = fixture();
    const filename = f.tracker().store.file(1);
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    value.format = 'iaf-mini/issue-run/v2';
    const original = JSON.stringify(value);
    fs.writeFileSync(filename, original);
    expect(() => newTracker(directory)).toThrow('新的 DATA_DIR');
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });

  it('手动回退创建新图轮次，只重跑目标及下游，旧执行器不能覆盖新检查点', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
    await f.workflow().drive();
    const stale = f.workflow();
    f.tracker().resetToPhase(1, 'verify', buildPlanModePipeline({ e2eEnabled: true }));
    expect(f.tracker().get(1)?.run?.workflow.generation).toBe(1);
    await expect(stale.drive()).rejects.toThrow('轮次已失效');
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver', 'verify', 'uat', 'deliver']);
  });

  it('取消在途阶段后保留检查点，暂停继续重入未完成节点且不重复上游', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
    const controller = new AbortController();
    const original = f.runner.run.bind(f.runner);
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const run = vi.spyOn(f.runner, 'run').mockImplementation(async spec => {
      f.calls.push(spec.id);
      reached();
      await new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('模拟阶段中止')), { once: true }));
      return { kind: 'completed', output: '' };
    });
    const driving = new IssueWorkflow({ ...f.options(), signal: controller.signal }).drive();
    const stopped = expect(driving).rejects.toThrow();
    await started;
    f.tracker().transaction(1, record => { record.run!.stopIntent = { kind: 'pause', requestedAt: new Date().toISOString() }; record.state = IssueState.Paused; record.pausedAtPhase = 'build'; });
    controller.abort();
    await stopped;
    expect(f.tracker().get(1)?.state).toBe(IssueState.Paused);
    run.mockImplementation(original);
    f.restart();
    f.tracker().resumeFromPause(1);
    expect(f.tracker().get(1)?.currentPhase).toBe('build');
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    await f.workflow().drive();
    expect(f.calls).toEqual(['plan', 'build', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.run?.workflow.generation).toBe(0);
    expect(f.tracker().get(1)?.state).toBe(IssueState.Completed);
  });

  it('修复额度耗尽进入人工失败状态，不滞留运行中或重新循环', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
    const original = f.runner.run.bind(f.runner);
    vi.spyOn(f.runner, 'run').mockImplementation((spec, context) => spec.id === 'verify'
      ? Promise.resolve({ kind: 'requestRetryFrom', targetPhaseId: 'build', reason: '验证失败' })
      : original(spec, context));
    await new IssueWorkflow({ ...f.options(), maxRepairs: 0 }).drive();
    expect(f.tracker().get(1)).toMatchObject({ state: IssueState.Failed, currentPhase: 'verify', lastErrorRetryable: false });
    expect(f.tracker().get(1)?.phaseHistory?.at(-1)?.outcome).toBe('failed');
  });

  it('审核事务成功后检查点写入失败，重启不重复审核且继续剩余节点', async () => {
    const f = fixture();
    await f.workflow().drive();
    const workflow = f.workflow();
    const original = workflow.checkpointer.putWrites.bind(workflow.checkpointer);
    let failed = false;
    vi.spyOn(workflow.checkpointer, 'putWrites').mockImplementation(async (...args) => {
      if (!failed && f.tracker().get(1)?.run?.review?.decision === 'approved') { failed = true; throw new Error('审核检查点写入中断'); }
      return original(...args);
    });
    await expect(workflow.resumeReview({ action: 'approve', planRevision: 1 })).rejects.toThrow('检查点');
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.phaseHistory?.filter(entry => entry.outcome === 'gate-approved')).toHaveLength(1);
  });

  it.each([false, true])('审核中断保存前退出，启动可恢复；旧等待投影=%s', async oldProjection => {
    const f = fixture();
    const workflow = f.workflow();
    const original = workflow.checkpointer.putWrites.bind(workflow.checkpointer);
    vi.spyOn(workflow.checkpointer, 'putWrites').mockImplementation(async (...args) => {
      if (args[1].some(([channel]) => channel === '__interrupt__')) throw new Error('模拟中断保存前退出');
      return original(...args);
    });
    await expect(workflow.drive()).rejects.toThrow('中断保存前退出');
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseRunning);
    if (oldProjection) f.tracker().updateState(1, IssueState.PhaseWaiting);
    const resumed = f.restart();
    expect(f.tracker().recoverInterruptedIssues()).toBe(1);
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    expect((await resumed.getState()).tasks.flatMap(task => task.interrupts ?? [])).toHaveLength(0);
    await resumed.drive();
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseWaiting);
    expect(f.calls).toEqual(['plan']);
    await resumed.resumeReview({ action: 'approve', planRevision: 1 });
    await resumed.drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
  });

  it('中断已保存但等待投影写入失败，重启仍可继续审核', async () => {
    const f = fixture();
    const transaction = f.tracker().transaction.bind(f.tracker());
    vi.spyOn(f.tracker(), 'transaction').mockImplementation((number, update) => transaction(number, record => {
      const before = record.state;
      update(record);
      if (before !== IssueState.PhaseWaiting && record.state === IssueState.PhaseWaiting) throw new Error('模拟等待投影写入失败');
    }));
    await expect(f.workflow().drive()).rejects.toThrow('等待投影写入失败');
    f.restart();
    const resumed = new IssueWorkflow({ ...f.options(), autoReview: () => 'configuration' });
    expect(f.tracker().recoverInterruptedIssues()).toBe(1);
    expect((await resumed.getState()).tasks.flatMap(task => task.interrupts ?? [])).toHaveLength(1);
    await resumed.drive();
    expect(f.tracker().get(1)?.state).toBe(IssueState.PhaseWaiting);
    expect(f.calls).toEqual(['plan']);
    await resumed.resumeReview({ action: 'approve', planRevision: 1 });
    await resumed.drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
  });

  it('显式失败重试立即可调度，并由原检查点定位失败阶段', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
    const original = f.runner.run.bind(f.runner);
    const run = vi.spyOn(f.runner, 'run').mockResolvedValue({ kind: 'failed', error: { message: '模拟失败', retryable: 'hard-no-auto' } });
    await f.workflow().drive();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.tracker().get(1)).toMatchObject({ state: IssueState.Failed, lastErrorRetryable: false });
    expect(f.tracker().get(1)?.run?.retryUsed.build).toBeUndefined();
    f.tracker().resetForRetry(1);
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    expect(f.tracker().get(1)?.currentPhase).toBe('build');
    run.mockImplementation(original);
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver']);
    expect(f.tracker().get(1)?.run?.workflow.generation).toBe(0);
  });

  it('已完成图的 PR 冲突修复明确重入 build，并保留原 PR 身份', async () => {
    const f = fixture();
    await f.workflow().drive();
    await f.workflow().resumeReview({ action: 'approve', planRevision: 1 });
    await f.workflow().drive();
    f.tracker().transaction(1, record => {
      record.run!.delivery = { repository: 'test/repo', issueNumber: 1, sourceBranch: 'iaf-1', targetBranch: 'main', marker: '原交付', creation: 'confirmed', prNumber: 8 };
    });
    const service = {
      executions: new Map(), tracker: f.tracker(), mainGitMutex: new AsyncMutex(), mainGit: { fetch: vi.fn().mockResolvedValue(undefined) },
      github: { getPullRequestDetail: vi.fn().mockResolvedValue({ state: 'open' }) },
      config: { project: { baseBranch: 'main' }, verifyFixLoop: { maxIterations: 2 } },
    } as unknown as IssueService;
    await IssueService.prototype.resolveConflict.call(service, 1);
    expect(f.tracker().getDrivableIssues(1)).toHaveLength(1);
    expect(f.tracker().get(1)?.run).toMatchObject({ workflow: { generation: 1, entry: 'build' }, repairRounds: 1, buildEntry: 'repair-integration', delivery: { prNumber: 8 } });
    await f.restart().drive();
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'uat', 'deliver', 'build', 'verify', 'uat', 'deliver']);
  });
});

it('关闭 E2E 的审核检查点跨实例恢复后，verify 直接交付且完成状态不重跑', async () => {
  const f = fixture(false);
  await f.workflow().drive();
  await f.restart().resumeReview({ action: 'approve', planRevision: 1 });
  await f.restart().drive();
  expect(f.calls).toEqual(['plan', 'build', 'verify', 'deliver']);
  expect(f.tracker().get(1)?.phaseProgress?.uat).toBeUndefined();
  expect(Object.values(f.tracker().get(1)!.run!.workflow.results)).toContainEqual(expect.objectContaining({ phase: 'verify', next: 'deliver' }));
  await f.restart().drive();
  expect(f.calls).toEqual(['plan', 'build', 'verify', 'deliver']);
});
