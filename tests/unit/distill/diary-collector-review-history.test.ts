/**
 * 单元测试：DiaryCollector 从 review-history.json 生成 review-reject 介入。
 *
 * 这是知识库蒸馏链路的关键修复 —— 在此之前 DiaryCollector 只生成
 * review-approve / retry 两种介入，所有审核驳回反馈对 MemoryDistiller 完全不可见。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiaryCollector } from '../../../src/distill/DiaryCollector.js';
import type { DiaryStore } from '../../../src/distill/DiaryStore.js';
import type { IssueTracker } from '../../../src/tracker/IssueTracker.js';
import type { PlanPersistence, ReviewRound } from '../../../src/persistence/PlanPersistence.js';
import { IssueState, type PhaseProgress } from '../../../src/tracker/IssueState.js';

function makeMockTracker(phaseProgress?: Record<string, PhaseProgress>): IssueTracker {
  return {
    get: vi.fn().mockReturnValue({
      state: IssueState.Completed,
      currentPhase: 'verify',
      attempts: 1,
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
      demandSpec: { title: 'Test Issue' },
      phaseProgress,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:30:00.000Z',
    }),
  } as unknown as IssueTracker;
}

function makeMockDiaryStore(): DiaryStore {
  return {
    create: vi.fn(),
    getByIssueIid: vi.fn().mockReturnValue([]),
  } as unknown as DiaryStore;
}

/** 构造 PlanPersistence 工厂：返回的 plan 对象只暴露 collector 用到的方法。 */
function makePlanFactory(opts: {
  reviewHistory?: ReviewRound[];
}): (number: number) => PlanPersistence | null {
  const planMock = {
    readReviewHistory: vi.fn().mockReturnValue(opts.reviewHistory ?? []),
  };
  return () => planMock as unknown as PlanPersistence;
}

describe('DiaryCollector 审核驳回反馈承接', () => {
  let tracker: IssueTracker;
  let diaryStore: DiaryStore;

  beforeEach(() => {
    tracker = makeMockTracker();
    diaryStore = makeMockDiaryStore();
  });

  it('无 review-history 时不生成 review-reject 介入', async () => {
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({ reviewHistory: [] }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const rejects = diary!.humanInterventions.filter((h) => h.type === 'review-reject');
    expect(rejects).toHaveLength(0);
  });

  it('单轮驳回生成 1 条 review-reject 介入，含轮次和 feedback', async () => {
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({
        reviewHistory: [{
          round: 1, feedback: '缺少错误处理', timestamp: '2025-01-01T00:05:00.000Z',
        }],
      }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const rejects = diary!.humanInterventions.filter((h) => h.type === 'review-reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0].detail).toContain('第 1 轮驳回');
    expect(rejects[0].detail).toContain('缺少错误处理');
    expect(rejects[0].timestamp).toBe('2025-01-01T00:05:00.000Z');
  });

  it('多轮驳回为每轮生成一条 review-reject，顺序保留', async () => {
    const history: ReviewRound[] = [
      { round: 1, feedback: '范围太大', timestamp: '2025-01-01T00:05:00.000Z' },
      { round: 2, feedback: '未考虑权限', timestamp: '2025-01-01T00:15:00.000Z' },
      { round: 3, feedback: '测试覆盖不足', timestamp: '2025-01-01T00:25:00.000Z' },
    ];
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({ reviewHistory: history }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const rejects = diary!.humanInterventions.filter((h) => h.type === 'review-reject');
    expect(rejects).toHaveLength(3);
    expect(rejects[0].detail).toContain('第 1 轮');
    expect(rejects[0].detail).toContain('范围太大');
    expect(rejects[1].detail).toContain('第 2 轮');
    expect(rejects[1].detail).toContain('未考虑权限');
    expect(rejects[2].detail).toContain('第 3 轮');
    expect(rejects[2].detail).toContain('测试覆盖不足');
  });

  it('长 feedback 自动截断到 200 字符并附加省略号', async () => {
    const longFeedback = 'a'.repeat(300);
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({
        reviewHistory: [{
          round: 1, feedback: longFeedback, timestamp: '2025-01-01T00:05:00.000Z',
        }],
      }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const reject = diary!.humanInterventions.find((h) => h.type === 'review-reject')!;
    expect(reject.detail.endsWith('...')).toBe(true);
    expect(reject.detail).toContain('a'.repeat(200));
    expect(reject.detail).not.toContain('a'.repeat(201));
  });

  it('feedback 中的多行空白被压成单空格（便于 prompt 单行渲染）', async () => {
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({
        reviewHistory: [{
          round: 1,
          feedback: '问题 1\n\n问题 2\n  问题 3',
          timestamp: '2025-01-01T00:05:00.000Z',
        }],
      }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const reject = diary!.humanInterventions.find((h) => h.type === 'review-reject')!;
    expect(reject.detail).toContain('问题 1 问题 2 问题 3');
    expect(reject.detail).not.toContain('\n');
  });

  it('与 review-approve 共存：驳回 + 最终通过都进入介入列表', async () => {
    tracker = makeMockTracker({
      review: { status: 'completed', completedAt: '2025-01-01T00:20:00.000Z' },
    });
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: makePlanFactory({
        reviewHistory: [{
          round: 1, feedback: '需要补充', timestamp: '2025-01-01T00:05:00.000Z',
        }],
      }),
    });

    const diary = await collector.collectDiary(42, 'completed');
    const types = diary!.humanInterventions.map((h) => h.type);
    expect(types).toContain('review-reject');
    expect(types).toContain('review-approve');
  });

  it('createPlanPersistence 未提供时不抛异常，回退为空 history', async () => {
    const collector = new DiaryCollector({ tracker, diaryStore });

    const diary = await collector.collectDiary(42, 'completed');
    expect(diary).not.toBeNull();
    const rejects = diary!.humanInterventions.filter((h) => h.type === 'review-reject');
    expect(rejects).toHaveLength(0);
  });

  it('plan.readReviewHistory 抛异常时整个采集失败返回 null（已有的 try/catch）', async () => {
    const planMock = {
      readReviewHistory: vi.fn().mockImplementation(() => { throw new Error('fs error'); }),
    };
    const collector = new DiaryCollector({
      tracker, diaryStore,
      createPlanPersistence: () => planMock as unknown as PlanPersistence,
    });

    const diary = await collector.collectDiary(42, 'completed');
    expect(diary).toBeNull();
  });
});
