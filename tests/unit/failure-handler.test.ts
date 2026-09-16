import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleFailure } from '../../src/orchestrator/steps/FailureHandler.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  createMockOrchestratorDeps,
  createTestIssue,
} from '../helpers/mock-factories.js';
import type { WorktreeContext } from '../../src/git/WorktreeContext.js';
import type { OrchestratorDeps } from '../../src/orchestrator/IssueProcessingContext.js';

function createWtCtx(): WorktreeContext {
  return {
    gitRootDir: '/tmp/worktree',
    workDir: '/tmp/worktree/app',
    branchName: 'feat/issue-42',
    issueIid: 42,
  };
}

describe('handleFailure', () => {
  let deps: OrchestratorDeps;
  const issue = createTestIssue();
  const wtCtx = createWtCtx();

  beforeEach(() => {
    deps = createMockOrchestratorDeps();
  });

  it('marks failed when resetGeneration matches (normal failure, not a concurrent reset)', async () => {
    (deps.tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'running', phase: 'build' },
      state: IssueState.PhaseRunning,
      attempts: 1,
      resetGeneration: 1,
    });

    // startResetGeneration=1, currentGeneration=1 → wasReset=false → should markFailed
    await expect(
      handleFailure(new Error('setup failed'), issue, wtCtx, deps, 1),
    ).rejects.toThrow('setup failed');

    expect(deps.tracker.markFailed).toHaveBeenCalledWith(
      issue.number,
      'setup failed',
      IssueState.PhaseRunning,
      true,
    );
  });

  it('skips markFailed when resetGeneration differs (concurrent reset)', async () => {
    (deps.tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'pending' },
      state: IssueState.Pending,
      attempts: 0,
      resetGeneration: 2,
    });

    // startResetGeneration=1, currentGeneration=2 → wasReset=true → skip markFailed
    await expect(
      handleFailure(new Error('killed'), issue, wtCtx, deps, 1),
    ).rejects.toThrow('killed');

    expect(deps.tracker.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed after resetFull when processing starts AFTER reset (the bug scenario)', async () => {
    // This is the core bug scenario:
    // restartIssue() resets state to Pending+attempts=0, generation becomes 1
    // NEW processIssue starts, snapshots generation=1
    // setup fails → handleFailure with startResetGeneration=1
    // tracker still has generation=1 → wasReset=false → should markFailed
    (deps.tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'pending' },
      state: IssueState.Pending,
      attempts: 0,
      resetGeneration: 1,
    });

    await expect(
      handleFailure(new Error('worktree failed'), issue, wtCtx, deps, 1),
    ).rejects.toThrow('worktree failed');

    // This is the fix: previously this would NOT have been called
    expect(deps.tracker.markFailed).toHaveBeenCalledWith(
      issue.number,
      'worktree failed',
      IssueState.Pending,
      true,
    );
  });

  it('尚未重置的任务按初始代数处理失败', async () => {
    // Old records have no resetGeneration field
    (deps.tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'running', phase: 'build' },
      state: IssueState.PhaseRunning,
      attempts: 1,
      // no resetGeneration → defaults to 0
    });

    // startResetGeneration=undefined → defaults to 0, currentGeneration=undefined → defaults to 0
    // 0 === 0 → wasReset=false → should markFailed
    await expect(
      handleFailure(new Error('some error'), issue, wtCtx, deps),
    ).rejects.toThrow('some error');

    expect(deps.tracker.markFailed).toHaveBeenCalled();
  });

  it('does not mark failed when already in Failed state', async () => {
    (deps.tracker.get as ReturnType<typeof vi.fn>).mockReturnValue({
      lifecycle: { kind: 'failed', retry: 'manual', error: { message: '已有失败' } },
      state: IssueState.Failed,
      attempts: 2,
      resetGeneration: 0,
    });

    await expect(
      handleFailure(new Error('retry failed'), issue, wtCtx, deps, 0),
    ).rejects.toThrow('retry failed');

    // failedAtState === Failed → condition is false → skip markFailed
    expect(deps.tracker.markFailed).not.toHaveBeenCalled();
  });
});
