import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiaryCollector } from '../../../src/distill/DiaryCollector.js';
import { eventBus } from '../../../src/events/EventBus.js';
import type { DiaryStore } from '../../../src/distill/DiaryStore.js';
import type { IssueTracker } from '../../../src/tracker/IssueTracker.js';
import { newIssueRun } from '../../../src/dag/contracts.js';

function makeMockTracker(): IssueTracker {
  return {
    get: vi.fn().mockReturnValue({
      lifecycle: { kind: 'completed' },
      run: newIssueRun(),
      phaseHistory: [],
      branchName: 'feat/issue-42',
      pipelineMode: 'classic',
      prUrl: 'https://example.com/pr/1',
      demandSpec: { title: 'Test Issue' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:10:00.000Z',
    }),
  } as unknown as IssueTracker;
}

function makeMockDiaryStore(): DiaryStore {
  return {
    create: vi.fn(),
    getByIssueIid: vi.fn().mockReturnValue([]),
  } as unknown as DiaryStore;
}

describe('DiaryCollector', () => {
  let tracker: IssueTracker;
  let diaryStore: DiaryStore;
  let collector: DiaryCollector;

  beforeEach(() => {
    tracker = makeMockTracker();
    diaryStore = makeMockDiaryStore();
    collector = new DiaryCollector({ tracker, diaryStore });
  });

  it('collects diary for completed issue', async () => {
    const diary = await collector.collectDiary(42, 'completed');

    expect(diary).not.toBeNull();
    expect(diary!.issueIid).toBe(42);
    expect(diary!.outcome).toBe('completed');
    expect(diary!.branchName).toBe('feat/issue-42');
    expect(diary!.distilled).toBe(false);
    expect(diaryStore.create).toHaveBeenCalledTimes(1);
  });

  it('skips a completed issue without meaningful diary content', async () => {
    (tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'completed' },
      run: newIssueRun(),
      phaseHistory: [],
      branchName: 'feat/issue-43',
      pipelineMode: 'classic',
      demandSpec: { title: 'Empty Issue' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:10:00.000Z',
    });

    const diary = await collector.collectDiary(43, 'completed');

    expect(diary).toBeNull();
    expect(diaryStore.create).not.toHaveBeenCalled();
  });

  it('collects diary for failed issue', async () => {
    (tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'failed', phase: 'build', retry: 'manual', error: { message: 'Build failed', retryable: 'hard-no-auto' } },
      run: { ...newIssueRun(), retryUsed: { build: 3 } },
      phaseHistory: [],
      branchName: 'feat/issue-99',
      pipelineMode: 'plan-mode',
      demandSpec: { title: 'Failed Issue' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:05:00.000Z',
    });

    const diary = await collector.collectDiary(99, 'failed');

    expect(diary).not.toBeNull();
    expect(diary!.outcome).toBe('failed');
    expect(diary!.failure).toBeDefined();
    expect(diary!.failure!.failedAtPhase).toBe('build');
    expect(diary!.failure!.error).toBe('Build failed');
    expect(diary!.failure!.attempts).toBe(3);
  });

  it('returns null when tracker record not found', async () => {
    (tracker.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const diary = await collector.collectDiary(404, 'completed');
    expect(diary).toBeNull();
  });

  it('computes timing correctly', async () => {
    const diary = await collector.collectDiary(42, 'completed');

    expect(diary!.timing.totalDurationMs).toBe(600000); // 10 minutes
    expect(diary!.timing.startedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(diary!.timing.finishedAt).toBe('2025-01-01T00:10:00.000Z');
  });

  it('records retry interventions when attempts > 1', async () => {
    (tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'completed' },
      run: { ...newIssueRun(), retryUsed: { build: 3 } },
      phaseHistory: [],
      branchName: 'feat/issue-42',
      pipelineMode: 'classic',
      demandSpec: { title: 'Test' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:10:00.000Z',
    });

    const diary = await collector.collectDiary(42, 'completed');
    expect(diary!.humanInterventions).toHaveLength(1);
    expect(diary!.humanInterventions[0].type).toBe('retry');
  });

  it('emits distill:diary:created event', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emitTyped');

    await collector.collectDiary(42, 'completed');

    expect(emitSpy).toHaveBeenCalledWith('distill:diary:created', expect.objectContaining({
      issueIid: 42,
      outcome: 'completed',
    }));

    emitSpy.mockRestore();
  });
});
