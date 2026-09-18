import { describe, expect, it, vi } from 'vitest';
import { WorktreeReaper } from '../../src/workspace/WorktreeReaper.js';
import type { IssueRecord } from '../../src/tracker/IssueRecord.js';
import type { IssueService } from '../../src/orchestrator/IssueService.js';
import { newIssueRun } from '../../src/dag/contracts.js';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY;
const EXPIRED = new Date(Date.now() - 8 * DAY).toISOString();
const FRESH = new Date(Date.now() - DAY).toISOString();

function makeRecord(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    lifecycle: { kind: 'completed' },
    branchName: `feat/issue-${number}`,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
    completedAt: EXPIRED,
    run: newIssueRun(),
    phaseHistory: [],
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue', externalId: String(number * 10), displayId: String(number) },
      title: `Issue ${number}`,
      description: '',
      createdAt: EXPIRED,
    },
    ...overrides,
  };
}

function makeOrchestrator(records: IssueRecord[]) {
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const orchestrator = {
    getTracker: () => ({ getAll: () => records }),
    cleanupCompletedWorktree: cleanup,
    cleanupExpiredTaskWorkspaces: vi.fn().mockResolvedValue(undefined),
  } as unknown as IssueService;
  return { orchestrator, cleanup };
}

function makeReaper(orchestrator: IssueService, enabled = true) {
  return new WorktreeReaper({ orchestrator, intervalMs: 60_000, retentionMs: RETENTION_MS, enabled });
}

describe('WorktreeReaper', () => {
  it('仅回收超过保留期且已完成的 worktree', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([
      makeRecord(1),
      makeRecord(2, { completedAt: FRESH }),
      makeRecord(3, { lifecycle: { kind: 'failed', phase: 'build', retry: 'manual', error: { message: '失败', retryable: 'hard-no-auto' } } }),
      makeRecord(4, { worktreeCleanedAt: FRESH }),
      makeRecord(5, { completedAt: undefined }),
    ]);
    const result = await makeReaper(orchestrator).reap();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(1);
    expect(result).toEqual({ reaped: 1, iids: [1] });
  });

  it('禁用时不执行清理', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([makeRecord(1)]);
    expect(await makeReaper(orchestrator, false).reap()).toMatchObject({ reaped: 0 });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('单个失败不影响其余回收', async () => {
    const { orchestrator, cleanup } = makeOrchestrator([makeRecord(1), makeRecord(2)]);
    cleanup.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    expect(await makeReaper(orchestrator).reap()).toEqual({ reaped: 1, iids: [2] });
  });

  it('累计回收数并记录扫描时间', async () => {
    const { orchestrator } = makeOrchestrator([makeRecord(1)]);
    const reaper = makeReaper(orchestrator);
    await reaper.reap();
    await reaper.reap();
    expect(reaper.getStatus()).toMatchObject({ totalReaped: 2, enabled: true, retentionMs: RETENTION_MS });
    expect(reaper.getStatus().lastScanAt).toBeDefined();
  });

  it('禁用时 start/stop 不抛错', () => {
    const { orchestrator } = makeOrchestrator([makeRecord(1)]);
    const reaper = makeReaper(orchestrator, false);
    expect(() => reaper.start()).not.toThrow();
    expect(() => reaper.stop()).not.toThrow();
  });
});
