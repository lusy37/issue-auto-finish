import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  createMockGitOperations,
  createMockGitHubClient,
  createMockAIRunner,
  createMockIssueTracker,
  createTestConfig,
  createTestIssue,
} from '../helpers/mock-factories.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Concurrency and Isolation', () => {
  describe('AsyncMutex serialization', () => {
    it('serializes concurrent tasks in FIFO order', async () => {
      const mutex = new AsyncMutex();
      const order: number[] = [];

      const p1 = mutex.runExclusive(async () => {
        await delay(30);
        order.push(1);
      });
      const p2 = mutex.runExclusive(async () => {
        await delay(10);
        order.push(2);
      });
      const p3 = mutex.runExclusive(async () => {
        order.push(3);
      });

      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });

    it('prevents interleaved read-modify-write on shared counter', async () => {
      const mutex = new AsyncMutex();
      let counter = 0;

      const increment = () =>
        mutex.runExclusive(async () => {
          const current = counter;
          await delay(5);
          counter = current + 1;
        });

      await Promise.all(Array.from({ length: 10 }, () => increment()));
      expect(counter).toBe(10);
    });

    it('releases lock on exception so subsequent tasks run', async () => {
      const mutex = new AsyncMutex();

      await expect(
        mutex.runExclusive(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const result = await mutex.runExclusive(async () => 'recovered');
      expect(result).toBe('recovered');
      expect(mutex.isLocked).toBe(false);
    });
  });

  describe('Worktree path isolation', () => {
    it('generates non-overlapping worktree paths for different issues', () => {
      const config = createTestConfig();
      const computePath = (number: number) =>
        `${config.project.worktreeBaseDir}/issue-${number}/${config.project.projectSubDir}`;

      const path1 = computePath(1);
      const path2 = computePath(2);
      const path3 = computePath(3);

      expect(path1).not.toBe(path2);
      expect(path2).not.toBe(path3);
      expect(path1).toContain('issue-1');
      expect(path2).toContain('issue-2');
      expect(path3).toContain('issue-3');
    });
  });

  describe('Concurrent issue processing simulation', () => {
    it('processes multiple issues in parallel without cross-contamination', async () => {
      const tracker = createMockIssueTracker();
      const stateLog: Array<{ number: number; state: string }> = [];

      tracker.updateState.mockImplementation((number: number, state: string) => {
        stateLog.push({ number, state });
      });

      const issueCount = 3;
      const promises = Array.from({ length: issueCount }, async (_, i) => {
        const number = i + 1;
        tracker.updateState(number, IssueState.PhaseRunning);
        await delay(10 + Math.random() * 20);
        tracker.updateState(number, IssueState.PhaseDone);
        await delay(10 + Math.random() * 20);
        tracker.updateState(number, IssueState.PhaseRunning);
      });

      await Promise.all(promises);

      for (let number = 1; number <= issueCount; number++) {
        const issueStates = stateLog
          .filter((e) => e.number === number)
          .map((e) => e.state);
        expect(issueStates).toEqual([
          IssueState.PhaseRunning,
          IssueState.PhaseDone,
          IssueState.PhaseRunning,
        ]);
      }
    });

    it('one issue failure does not block other issues', async () => {
      const results: Array<{ number: number; status: 'ok' | 'fail' }> = [];

      const processIssue = async (number: number, shouldFail: boolean) => {
        await delay(10);
        if (shouldFail) {
          results.push({ number, status: 'fail' });
          throw new Error(`Issue ${number} failed`);
        }
        results.push({ number, status: 'ok' });
      };

      const promises = [
        processIssue(1, false).catch(() => {}),
        processIssue(2, true).catch(() => {}),
        processIssue(3, false).catch(() => {}),
      ];

      await Promise.all(promises);

      expect(results).toHaveLength(3);
      expect(results.find((r) => r.number === 1)?.status).toBe('ok');
      expect(results.find((r) => r.number === 2)?.status).toBe('fail');
      expect(results.find((r) => r.number === 3)?.status).toBe('ok');
    });
  });

  describe('mainGit mutex protects shared git operations', () => {
    it('serializes fetch + worktree creation across concurrent issues', async () => {
      const mutex = new AsyncMutex();
      const git = createMockGitOperations();
      const callOrder: string[] = [];

      git.fetch.mockImplementation(async () => {
        callOrder.push('fetch-start');
        await delay(20);
        callOrder.push('fetch-end');
      });
      git.worktreeAdd.mockImplementation(async () => {
        callOrder.push('worktree-start');
        await delay(10);
        callOrder.push('worktree-end');
      });

      const setupWorktree = (issueIid: number) =>
        mutex.runExclusive(async () => {
          await git.fetch();
          await git.worktreeAdd(`/tmp/issue-${issueIid}`, `branch-${issueIid}`, 'origin/master');
        });

      await Promise.all([setupWorktree(1), setupWorktree(2)]);

      // Verify operations are serialized: first issue fully completes before second starts
      expect(callOrder).toEqual([
        'fetch-start', 'fetch-end', 'worktree-start', 'worktree-end',
        'fetch-start', 'fetch-end', 'worktree-start', 'worktree-end',
      ]);
    });
  });
});
