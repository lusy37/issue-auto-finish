/**
 * DiaryCollector — Layer 1: 自动采集 Issue 经验日记。
 *
 * 监听 EventBus 的 issue:stateChanged 事件，当 Issue 进入 Completed 或 Failed
 * 状态时，采集 tracker + plan persistence 数据写入 DiaryStore。
 *
 * fire-and-forget：不阻塞主流程，失败只打日志。
 */
import { randomUUID } from 'node:crypto';
import { eventBus, type EventPayload } from '../events/EventBus.js';
import { logger as rootLogger } from '../logger.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { PlanPersistence, ReviewRound } from '../persistence/PlanPersistence.js';
import { IssueState, type ProgressData } from '../tracker/IssueState.js';
import type { DiaryStore } from './DiaryStore.js';
import type { DiaryEntry, DiaryPhaseTiming, DiaryHumanIntervention } from './types.js';

/** review feedback 摘要进 diary 时的最大长度，避免单条 prompt 体积爆炸 */
const REVIEW_FEEDBACK_SUMMARY_MAX = 200;

const logger = rootLogger.child('DiaryCollector');

export interface DiaryCollectorDeps {
  tracker: IssueTracker;
  diaryStore: DiaryStore;
  /** 工厂函数：给定 issueIid 返回对应的 PlanPersistence（或 null） */
  createPlanPersistence?: (issueIid: number) => PlanPersistence | null;
}

export class DiaryCollector {
  private tracker: IssueTracker;
  private diaryStore: DiaryStore;
  private createPlanPersistence?: (issueIid: number) => PlanPersistence | null;

  /** Saved handler references for cleanup in stop() */
  private stateChangedHandler: ((payload: EventPayload) => void) | null = null;
  private failedHandler: ((payload: EventPayload) => void) | null = null;

  constructor(deps: DiaryCollectorDeps) {
    this.tracker = deps.tracker;
    this.diaryStore = deps.diaryStore;
    this.createPlanPersistence = deps.createPlanPersistence;
  }

  /** 开始监听事件（幂等：已启动时直接 return） */
  start(): void {
    if (this.stateChangedHandler) return;

    this.stateChangedHandler = (payload: EventPayload) => {
      this.handleStateChanged(payload).catch((err) => {
        logger.warn('DiaryCollector failed to handle stateChanged event', {
          error: (err as Error).message,
        });
      });
    };

    this.failedHandler = (payload: EventPayload) => {
      this.handleFailed(payload).catch((err) => {
        logger.warn('DiaryCollector failed to handle failed event', {
          error: (err as Error).message,
        });
      });
    };

    eventBus.on('issue:stateChanged', this.stateChangedHandler);
    eventBus.on('issue:failed', this.failedHandler);

    logger.info('DiaryCollector started');
  }

  /** 停止监听事件 */
  stop(): void {
    if (this.stateChangedHandler) {
      eventBus.off('issue:stateChanged', this.stateChangedHandler);
      this.stateChangedHandler = null;
    }
    if (this.failedHandler) {
      eventBus.off('issue:failed', this.failedHandler);
      this.failedHandler = null;
    }
    logger.info('DiaryCollector stopped');
  }

  /** 处理 issue:stateChanged 事件 */
  private async handleStateChanged(payload: EventPayload): Promise<void> {
    const data = payload.data as Record<string, unknown>;
    const state = data.state as string | undefined;

    // 只在进入 Completed 时触发日记采集
    if (state !== IssueState.Completed) return;

    const issueIid = data.issueIid as number | undefined;
    if (!issueIid) return;

    // 避免重复采集
    await this.collectDiary(issueIid, 'completed');
  }

  /** 处理 issue:failed 事件 */
  private async handleFailed(payload: EventPayload): Promise<void> {
    const data = payload.data as Record<string, unknown>;
    const issueIid = data.issueIid as number | undefined;
    if (!issueIid) return;

    await this.collectDiary(issueIid, 'failed');
  }

  /** 核心采集逻辑 */
  async collectDiary(issueIid: number, outcome: 'completed' | 'failed'): Promise<DiaryEntry | null> {
    try {
      const record = this.tracker.get(issueIid);
      if (!record) {
        logger.warn('Cannot collect diary: issue record not found', { issueIid });
        return null;
      }

      // 从 PlanPersistence 读取阶段进度和审核历史
      const plan = this.createPlanPersistence?.(issueIid);
      const progress = plan?.readProgress() ?? null;
      const reviewHistory = plan?.readReviewHistory() ?? [];

      const executionKey = [issueIid, record.resetGeneration ?? 0, record.attempts, outcome, record.phaseHistory?.length ?? 0].join(':');
      if (this.diaryStore.getByIssueIid(issueIid).some(d => d.executionKey === executionKey)) return null;
      const timing = this.buildTiming(record, progress);
      const failure = outcome === 'failed' ? this.buildFailure(record) : undefined;
      const interventions = this.buildInterventions(record, progress, reviewHistory);

      const diary: DiaryEntry = {
        id: randomUUID(),
        executionKey,
        issueIid,
        issueTitle: record.demandSpec?.title ?? `Issue #${issueIid}`,
        branchName: record.branchName,
        pipelineMode: record.pipelineMode ?? 'unknown',
        outcome,
        prUrl: record.prUrl,
        timing,
        failure,
        humanInterventions: interventions,
        distilled: false,
        createdAt: new Date().toISOString(),
      };

      this.diaryStore.create(diary);
      eventBus.emitTyped('distill:diary:created', { issueIid, diaryId: diary.id, outcome });
      logger.info('Diary collected', { issueIid, diaryId: diary.id, outcome });

      return diary;
    } catch (err) {
      logger.warn('Failed to collect diary', {
        issueIid,
        outcome,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /** 构建执行计时信息 */
  private buildTiming(
    record: { createdAt: string; updatedAt: string },
    progress: ProgressData | null,
  ): DiaryEntry['timing'] {
    const startedAt = record.createdAt;
    const finishedAt = record.updatedAt;
    const totalDurationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    const phaseTimings: DiaryPhaseTiming[] = [];
    if (progress?.phases) {
      for (const [phaseName, phaseProgress] of Object.entries(progress.phases)) {
        if (phaseProgress.startedAt) {
          const endTime = phaseProgress.completedAt ?? finishedAt;
          const durationMs = new Date(endTime).getTime() - new Date(phaseProgress.startedAt).getTime();
          phaseTimings.push({
            phase: phaseName,
            durationMs: Math.max(0, durationMs),
            retries: 0, // 重试信息在 tracker 层面，phase 层面不详细区分
          });
        }
      }
    }

    return {
      totalDurationMs: Math.max(0, totalDurationMs),
      phaseTimings,
      startedAt,
      finishedAt,
    };
  }

  /** 构建失败信息 */
  private buildFailure(
    record: { lastError?: string; failedAtState?: IssueState; attempts: number; currentPhase?: string },
  ): DiaryEntry['failure'] {
    return {
      failedAtPhase: record.currentPhase ?? record.failedAtState ?? 'unknown',
      error: record.lastError ?? 'Unknown error',
      attempts: record.attempts,
    };
  }

  /**
   * 构建人工介入记录，覆盖三类来源：
   *   1. retry — Issue 重试次数 > 1
   *   2. review-reject — review-history.json 中每一轮人工驳回（含 feedback 摘要）
   *   3. review-approve — review 阶段最终被批准（含通过时间）
   *
   * 这三类信息会随 diary 一起进入 MemoryDistiller 的分析 prompt，
   * 让 AI 能从"被驳回的方案模式 + 驳回原因"中蒸馏出 rejection-pattern。
   */
  private buildInterventions(
    record: { attempts: number },
    progress: ProgressData | null,
    reviewHistory: ReviewRound[],
  ): DiaryHumanIntervention[] {
    const interventions: DiaryHumanIntervention[] = [];

    if (record.attempts > 1) {
      interventions.push({
        type: 'retry',
        detail: `Issue 经过 ${record.attempts} 次尝试`,
        timestamp: new Date().toISOString(),
      });
    }

    for (const round of reviewHistory) {
      interventions.push({
        type: 'review-reject',
        detail: this.summarizeRejection(round),
        timestamp: round.timestamp,
      });
    }

    if (progress?.phases) {
      const reviewPhase = progress.phases['review'];
      if (reviewPhase?.status === 'completed') {
        interventions.push({
          type: 'review-approve',
          detail: '方案审核通过',
          timestamp: reviewPhase.completedAt ?? new Date().toISOString(),
        });
      }
    }

    return interventions;
  }

  /** 把一轮驳回压缩成单行摘要：第 N 轮 + 截断后的 feedback。 */
  private summarizeRejection(round: ReviewRound): string {
    const feedback = round.feedback.replace(/\s+/g, ' ').trim();
    const truncated = feedback.length > REVIEW_FEEDBACK_SUMMARY_MAX
      ? `${feedback.slice(0, REVIEW_FEEDBACK_SUMMARY_MAX)}...`
      : feedback;
    return `第 ${round.round} 轮驳回: ${truncated}`;
  }
}
