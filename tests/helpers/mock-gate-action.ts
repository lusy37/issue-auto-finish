/**
 * 模拟 PipelineOrchestrator.applyGateAction 的副作用，供集成测试 mock orchestrator 使用。
 *
 * 真实 PipelineOrchestrator.applyGateAction 走：
 *   1. Reducer.applyGateAction → 计算 nextState + historyEntry + sideEffects
 *   2. SideEffectExecutor 处理 emit-event
 *   3. TrackerStateStore.applyTransition → 更新 orchestrationState / phaseProgress / phaseHistory
 *   4. reject 额外副作用：persistRejectFeedback + initPhaseProgress + syncRejectFeedbackToIssue
 *
 * 本 helper 复现 reject 路径中对外部观测点（PlanPersistence 文件、tracker mock 方法、eventBus、github）
 * 的全部影响，让 mock 出来的 orchestrator 行为与真实实现等价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { eventBus } from '../../src/events/EventBus.js';
import type { GateAction } from '../../src/orchestration/index.js';
import { isNoteSyncEnabledForIssue } from '../../src/notesync/NoteSyncSettings.js';
import { getIssueNumber } from '../../src/tracker/IssueRecordHelper.js';
import { t } from '../../src/i18n/index.js';
import type { Config } from '../../src/config.js';
import type { PipelineDef } from '../../src/pipeline/PipelineDefinition.js';

export interface MockGateActionDeps {
  tracker: {
    get: (number: number) => Record<string, unknown> | undefined;
    updateState: (...args: unknown[]) => void;
    setOrchestrationState?: (...args: unknown[]) => void;
    updatePhaseProgress: (...args: unknown[]) => void;
    appendPhaseHistory: (...args: unknown[]) => void;
    initPhaseProgress: (...args: unknown[]) => void;
  };
  config: Config;
  pipelineDef: PipelineDef;
  github?: { createIssueNote: (...args: unknown[]) => Promise<void> };
}

/**
 * 计算 worktree 内 primary 子项目的 cwd（与 PipelineOrchestrator.computeWorktreeContext 等价的简化版）。
 */
function computeWorktreeWorkDir(number: number, config: Config): string {
  return path.join(
    config.project.worktreeBaseDir,
    `issue-${number}`,
    config.project.projectSubDir ?? '',
  );
}

/**
 * 构造一个模拟 PipelineOrchestrator.applyGateAction 行为的 async 函数，
 * 供集成测试中 mockOrchestrator.applyGateAction 使用。
 *
 * 保证副作用与真实 PipelineOrchestrator 等价：
 *   - approve：tracker 状态转 PhaseApproved + phaseProgress 标记 completed + appendPhaseHistory + emit gate:approved
 *   - reject ：写 review-history（worktree 存在）或后备文件，重置 phaseProgress，发 gate:rejected，
 *              （可选）同步驳回评论到GitHub
 */
export function createMockApplyGateAction(deps: MockGateActionDeps) {
  return async (number: number, action: GateAction): Promise<void> => {
    const record = deps.tracker.get(number) as
      | { state?: string; currentPhase?: string; pipelineMode?: string }
      | undefined;
    if (!record) throw new Error(`Issue #${number} not found`);

    if (record.state !== IssueState.PhaseWaiting) {
      throw new Error(
        `Gate action requires gate-waiting state, got '${record.state ?? 'undefined'}'`,
      );
    }

    const phaseId = record.currentPhase ?? '';

    if (action.action === 'approve') {
      await applyApprove(number, phaseId, deps);
    } else if (action.action === 'reject') {
      await applyReject(number, phaseId, action.feedback, record, deps);
    } else if (action.action === 'supplement') {
      eventBus.emitTyped('gate:supplemented', {
        issueIid: number, phaseId, context: action.context,
      });
    }
  };
}

async function applyApprove(
  number: number,
  phaseId: string,
  deps: MockGateActionDeps,
): Promise<void> {
  const now = new Date().toISOString();
  deps.tracker.updateState(number, IssueState.PhaseApproved, { currentPhase: phaseId });
  deps.tracker.updatePhaseProgress(number, phaseId, { status: 'completed', completedAt: now });
  deps.tracker.appendPhaseHistory(number, {
    phaseId, attemptId: 0, startedAt: now, endedAt: now, outcome: 'gate-approved',
  });
  eventBus.emitTyped('gate:approved', { issueIid: number, phaseId });
}

async function applyReject(
  number: number,
  phaseId: string,
  feedback: string,
  record: { pipelineMode?: string },
  deps: MockGateActionDeps,
): Promise<void> {
  const now = new Date().toISOString();
  const workDir = computeWorktreeWorkDir(number, deps.config);
  const round = persistReviewFeedback(number, workDir, feedback);

  deps.tracker.updateState(number, IssueState.BranchCreated, { currentPhase: undefined });
  deps.tracker.appendPhaseHistory(number, {
    phaseId, attemptId: 0, startedAt: now, endedAt: now, outcome: 'gate-rejected',
  });
  deps.tracker.updatePhaseProgress(number, phaseId, { status: 'pending' });
  deps.tracker.initPhaseProgress(number, deps.pipelineDef);
  eventBus.emitTyped('gate:rejected', { issueIid: number, phaseId, feedback });

  if (deps.github && isNoteSyncEnabledForIssue(number, deps.tracker as never, deps.config)) {
    const baseUrl = deps.config.issueNoteSync.webBaseUrl.replace(/\/$/, '');
    const planFile = record.pipelineMode === 'plan-mode' ? '01-plan.md' : '02-design.md';
    const note = [
      t('api.reviewFeedback', { round }),
      '',
      feedback,
      '',
      '---',
      t('api.viewPlan', { url: `${baseUrl}/doc/${number}/${planFile}` }),
      t('api.viewDetail', { url: `${baseUrl}/?issue=${number}` }),
    ].join('\n');
    try {
      await deps.github.createIssueNote(getIssueNumber(record as never), note);
    } catch { /* 测试 mock 同步失败不阻塞 */ }
  }
}

function persistReviewFeedback(number: number, workDir: string, feedback: string): number {
  if (fs.existsSync(workDir)) {
    const planPersistence = new PlanPersistence(workDir, number);
    const snapshot = planPersistence.readFile('01-plan.md') ?? undefined;
    const reviewedSessionId = planPersistence.getPhaseSessionId('plan');
    planPersistence.writeReviewFeedback(feedback, snapshot, reviewedSessionId);
    return planPersistence.readReviewHistory().length;
  }
  PlanPersistence.writeReviewFeedbackBackup(number, feedback);
  return PlanPersistence.readReviewHistoryBackup(number).length;
}
