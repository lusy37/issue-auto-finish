/**
 * 集成测试：真实 PipelineOrchestrator.applyGateAction(reject) 端到端
 *
 * 用真实的 PipelineOrchestrator + 真实 IssueTracker + 真实 PlanPersistence，
 * 仅 mock git / github / aiRunner 外部副作用。
 *
 * 校验维度（按 PR4 正统 Reducer 路径）：
 *   1. orchestrationState 从 gate-waiting → queued
 *   2. IssueState 从 PhaseWaiting → BranchCreated；currentPhase 清空
 *   3. phaseHistory 追加 outcome='gate-rejected' 条目
 *   4. phaseProgress 所有阶段重置为 pending（initPhaseProgress 副作用）
 *   5. worktree 内 review-history.json 写入本轮反馈 + planSnapshot
 *   6. 发出统一事件 gate:rejected（不再发老的 review:rejected）
 *   7. 同步评论到GitHub（issueNoteSync.enabled=true 时）
 *   8. reject 在非 review-gate 抛 GateActionError('reject-not-allowed')
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PipelineOrchestrator } from '../../src/orchestrator/PipelineOrchestrator.js';
import { GateActionError } from '../../src/orchestration/index.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { EventBus } from '../../src/events/EventBus.js';
import {
  createHarness,
  type IntegrationHarness,
} from '../helpers/integration-harness.js';

interface CapturedEvent { type: string; data: unknown }

function createRejectableRecord(number: number, branchName: string): Omit<IssueRecord, 'createdAt' | 'updatedAt' | 'attempts'> {
  return {
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue', externalId: String(number + 100), displayId: String(number) },
      title: `Reject Test ${number}`,
      description: 'desc',
      createdAt: '2024-01-01T00:00:00Z',
    },
    state: IssueState.PhaseWaiting,
    currentPhase: 'review',
    pipelineMode: 'plan-mode',
    branchName,
    orchestrationState: { kind: 'gate-waiting', phaseId: 'review', reason: 'human-review' },
  };
}

describe('PipelineOrchestrator.applyGateAction(reject) — 真实端到端', () => {
  let harness: IntegrationHarness;
  let orchestrator: PipelineOrchestrator;
  let eventBus: EventBus;
  let captured: CapturedEvent[];

  beforeEach(() => {
    harness = createHarness({
      // 启用 noteSync 验证 reject 评论同步到GitHub
      issueNoteSync: { enabled: true, webBaseUrl: 'http://localhost:3000' },
    });
    eventBus = new EventBus();
    captured = [];
    eventBus.on('*', (_evt: unknown, payload: unknown) => {
      const p = payload as { type?: string; data?: unknown };
      if (p?.type) captured.push({ type: p.type, data: p.data });
    });
    orchestrator = new PipelineOrchestrator(
      harness.config,
      harness.github as never,
      harness.git as never,
      harness.aiRunner as never,
      harness.tracker,
      undefined,
      undefined,
      eventBus,
    );
  });

  afterEach(() => {
    harness.cleanup();
  });

  it('reject 触发完整副作用链：状态转 queued + phaseHistory + initPhaseProgress + review-history + GitHub评论 + gate:rejected', async () => {
    const number = 42;
    const branchName = `feat/issue-${number}`;
    harness.tracker.create(createRejectableRecord(number, branchName));
    // 模拟流水线已跑到 review 阶段
    harness.tracker.initPhaseProgress(number, orchestrator.getPipelineDef());
    harness.tracker.updatePhaseProgress(number, 'plan', { status: 'completed' });
    harness.tracker.updatePhaseProgress(number, 'review', { status: 'gate_waiting' });

    // 准备 worktree 目录 + 已存在的 01-plan.md（用作 reject 时的 planSnapshot）
    const workDir = path.join(
      harness.config.project.worktreeBaseDir, `issue-${number}`,
      harness.config.project.projectSubDir ?? '',
    );
    fs.mkdirSync(workDir, { recursive: true });
    const planDir = path.join(workDir, '.claude-plan', `issue-${number}`);
    fs.mkdirSync(planDir, { recursive: true });
    const planContent = '# 初版方案\n\n这是初版需要被驳回。\n';
    fs.writeFileSync(path.join(planDir, '01-plan.md'), planContent);

    const feedback = '需要补充错误处理逻辑';
    await orchestrator.applyGateAction(number, { action: 'reject', feedback });

    // ── 1. orchestrationState 转 queued + state 转 BranchCreated + currentPhase 清空 ──
    const after = harness.tracker.get(number)!;
    expect(after.state).toBe(IssueState.BranchCreated);
    expect(after.currentPhase).toBeUndefined();
    expect(after.orchestrationState).toEqual({ kind: 'queued' });

    // ── 2. phaseHistory 追加 outcome='gate-rejected' 条目 ──
    const lastHistory = after.phaseHistory?.at(-1);
    expect(lastHistory).toMatchObject({ phaseId: 'review', outcome: 'gate-rejected' });

    // ── 3. phaseProgress 所有阶段重置为 pending ──
    for (const spec of orchestrator.getPipelineDef().phases) {
      expect(after.phaseProgress?.[spec.name]?.status).toBe('pending');
    }

    // ── 4. worktree 内 review-history.json 写入本轮反馈 + planSnapshot ──
    const historyFile = path.join(planDir, 'review-history.json');
    expect(fs.existsSync(historyFile)).toBe(true);
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(history).toHaveLength(1);
    expect(history[0].feedback).toBe(feedback);
    expect(history[0].planSnapshot).toBe(planContent);

    // ── 5. 发出统一事件 gate:rejected（不再发 review:rejected）──
    const rejectedEvents = captured.filter(e => e.type === 'gate:rejected');
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0].data).toMatchObject({ issueIid: number, phaseId: 'review', feedback });
    expect(captured.find(e => e.type === 'review:rejected')).toBeUndefined();

    // ── 6. 同步驳回评论到GitHub（issueNoteSync.enabled=true）──
    expect(harness.github.createIssueNote).toHaveBeenCalledTimes(1);
    const noteCall = (harness.github.createIssueNote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(noteCall[1]).toMatch(feedback);
  });

  it('reject 在 release-gate 抛 GateActionError(reject-not-allowed)', async () => {
    const number = 43;
    const branchName = `feat/issue-${number}`;
    // release 不在默认 plan-mode 里，但 issue 处于 PhaseWaiting+release 状态时 Reducer 会校验 phaseId
    harness.tracker.create({
      demandSpec: {
        demandId: `gh-${number}`,
        sourceRef: { source: 'github-issue', externalId: String(number + 100), displayId: String(number) },
        title: 'Release Reject',
        description: 'desc',
        createdAt: '2024-01-01T00:00:00Z',
      },
      state: IssueState.PhaseWaiting,
      currentPhase: 'release',
      pipelineMode: 'plan-mode',
      branchName,
      orchestrationState: { kind: 'gate-waiting', phaseId: 'release', reason: 'release-confirm' },
    });

    await expect(
      orchestrator.applyGateAction(number, { action: 'reject', feedback: 'nope' }),
    ).rejects.toBeInstanceOf(GateActionError);
  });

  it('reject 在非 gate-waiting 状态抛 GateActionError(invalid-state)', async () => {
    const number = 44;
    const branchName = `feat/issue-${number}`;
    harness.tracker.create({
      demandSpec: {
        demandId: `gh-${number}`,
        sourceRef: { source: 'github-issue', externalId: String(number + 100), displayId: String(number) },
        title: 'Wrong State',
        description: 'desc',
        createdAt: '2024-01-01T00:00:00Z',
      },
      state: IssueState.PhaseRunning,
      currentPhase: 'plan',
      pipelineMode: 'plan-mode',
      branchName,
      orchestrationState: { kind: 'running', phaseId: 'plan' },
    });

    await expect(
      orchestrator.applyGateAction(number, { action: 'reject', feedback: 'nope' }),
    ).rejects.toBeInstanceOf(GateActionError);
  });

  it('worktree 缺失时 reject 仍持久化到全局后备路径，且其他副作用不退化', async () => {
    const number = 45;
    const branchName = `feat/issue-${number}`;
    harness.tracker.create(createRejectableRecord(number, branchName));
    harness.tracker.initPhaseProgress(number, orchestrator.getPipelineDef());

    // 故意不创建 worktree → persistRejectFeedback 走 writeReviewFeedbackBackup
    process.env.DATA_DIR = harness.dataDir; // 把后备路径定到测试临时目录
    try {
      const feedback = 'worktree 缺失时的反馈';
      await orchestrator.applyGateAction(number, { action: 'reject', feedback });

      // 反馈应落到全局后备目录
      const backups = PlanPersistence.readReviewHistoryBackup(number);
      expect(backups).toHaveLength(1);
      expect(backups[0].feedback).toBe(feedback);

      // 状态 / 事件 / phaseProgress 仍正确
      const after = harness.tracker.get(number)!;
      expect(after.state).toBe(IssueState.BranchCreated);
      expect(after.orchestrationState).toEqual({ kind: 'queued' });
      for (const spec of orchestrator.getPipelineDef().phases) {
        expect(after.phaseProgress?.[spec.name]?.status).toBe('pending');
      }
      const rejectedEvents = captured.filter(e => e.type === 'gate:rejected');
      expect(rejectedEvents).toHaveLength(1);
    } finally {
      delete process.env.DATA_DIR;
    }
  });
});
