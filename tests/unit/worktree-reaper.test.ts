import { describe, it, expect, vi } from 'vitest';
import { WorktreeReaper } from '../../src/workspace/WorktreeReaper.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import type { PipelineOrchestrator } from '../../src/orchestrator/PipelineOrchestrator.js';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY;
const EXPIRED = new Date(Date.now() - 8 * DAY).toISOString();
const FRESH = new Date(Date.now() - 1 * DAY).toISOString();

function makeRecord(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    state: IssueState.Completed,
    branchName: `feat/issue-${number}`,
    attempts: 0,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
    completedAt: EXPIRED,
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue', externalId: String(number * 10), displayId: String(number) },
      title: `Issue ${number}`,
      description: '',
      createdAt: EXPIRED,
    },
    ...overrides,
  } as IssueRecord;
}

function makeOrchestrator(records: IssueRecord[]) {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const orchestrator = {
    getTracker: () => ({ getAll: () => records }),
    cleanupCompletedWorktree: cleanup,
  } as unknown as PipelineOrchestrator;
  return { orchestrator, cleanup };
}

function makeReaper(orchestrators: PipelineOrchestrator[], enabled = true) {
  return new WorktreeReaper({
    orchestrator: orchestrators[0],
    intervalMs: 60_000,
    retentionMs: RETENTION_MS,
    enabled,
  });
}

describe('WorktreeReaper.reap', () => {
  it('回收超过保留期的已完成 worktree', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([makeRecord(42)]);
    const result = await makeReaper([orchestrator]).reap();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(42);
    expect(result).toEqual({ reaped: 1, iids: [42] });
  });

  it('保留期内的 worktree 不回收', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      makeRecord(42, { completedAt: FRESH }),
    ]);
    const result = await makeReaper([orchestrator]).reap();

    expect(cleanup).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it('已清理过的记录跳过（worktreeCleanedAt 存在）', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      makeRecord(42, { worktreeCleanedAt: new Date().toISOString() }),
    ]);
    await makeReaper([orchestrator]).reap();

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('没有 completedAt 的记录跳过', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      makeRecord(42, { completedAt: undefined }),
    ]);
    await makeReaper([orchestrator]).reap();

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('失败态的 worktree 保留以便调试，不回收', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      makeRecord(42, { state: IssueState.Failed }),
    ]);
    await makeReaper([orchestrator]).reap();

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('禁用时不执行任何清理', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([makeRecord(42)]);
    const result = await makeReaper([orchestrator], false).reap();

    expect(cleanup).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it('单个清理失败不影响其它 issue 回收', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const orchestrator = {
      getTracker: () => ({ getAll: () => [makeRecord(1), makeRecord(2)] }),
      cleanupCompletedWorktree: cleanup,
    } as unknown as PipelineOrchestrator;

    const result = await makeReaper([orchestrator]).reap();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ reaped: 1, iids: [2] });
  });

  it('累计回收数并记录扫描时间', async () => {
    const { orchestrator } = makeOrchestrator([makeRecord(42)]);
    const reaper = makeReaper([orchestrator]);

    await reaper.reap();
    await reaper.reap();

    const status = reaper.getStatus();
    expect(status.totalReaped).toBe(2);
    expect(status.lastScanAt).toBeDefined();
    expect(status.enabled).toBe(true);
    expect(status.retentionMs).toBe(RETENTION_MS);
  });
});

describe('WorktreeReaper.start', () => {
  it('禁用时 start/stop 不抛错且不调度', () => {
    const { orchestrator } = makeOrchestrator([makeRecord(42)]);
    const reaper = makeReaper([orchestrator], false);

    expect(() => reaper.start()).not.toThrow();
    expect(() => reaper.stop()).not.toThrow();
    expect(reaper.getStatus().enabled).toBe(false);
  });

  it('启用时定时触发回收', async () => {
    vi.useFakeTimers();
    try {
      const { orchestrator, cleanup } = makeOrchestrator([makeRecord(42)]);
      const reaper = makeReaper([orchestrator]);
      reaper.start();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanup).toHaveBeenCalledWith(42);

      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
