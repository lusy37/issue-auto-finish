import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { getIssueNumber } from '../../src/tracker/IssueRecordHelper.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';

const planModeLM = PLAN_MODE_PIPELINE;

function createTracker(dir: string) {
  return new IssueTracker(dir, new Map([['plan-mode', planModeLM]]));
}

describe('IssueTracker', () => {
  let tmpDir: string;
  let tracker: IssueTracker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
    tracker = createTracker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRecord(number: number, state: IssueState, updatedAt?: string) {
    const record = tracker.create({
      demandSpec: {
        demandId: `gh-${number}`,
        sourceRef: { source: 'github-issue', externalId: `${number + 100}`, displayId: `${number}` },
        title: `Issue ${number}`,
        description: '',
        createdAt: '2024-01-01T00:00:00Z',
      },
      state: IssueState.Pending,
      branchName: `feat/issue-${number}`,
    });
    if (state !== IssueState.Pending) {
      tracker.updateState(number, state);
    }
    if (updatedAt) {
      const raw = JSON.parse(fs.readFileSync(tracker.store.file(number), 'utf-8'));
      raw.record.updatedAt = updatedAt;
      fs.writeFileSync(tracker.store.file(number), JSON.stringify(raw, null, 2));
      // Reload tracker to pick up the manual edit
      tracker = createTracker(tmpDir);
    }
    return record;
  }

  describe('加载记录校验', () => {
    it.each([
      { name: '空记录', record: null, reason: '缺少需求来源' },
      { name: '缺失 sourceRef', record: { demandSpec: {} }, reason: '缺少需求来源' },
      { name: '来源不受支持', record: { demandSpec: { sourceRef: { source: 'user-input' } } }, reason: '任务来源必须为 GitHub Issue' },
      { name: '状态无效', record: { demandSpec: { sourceRef: { source: 'github-issue' } }, state: 'unknown' }, reason: '任务状态无效' },
    ])('$name 时提供可定位的格式错误并保留原文件', ({ record }) => {
      const filePath = path.join(tmpDir, 'tracker.json');
      const content = JSON.stringify({ format: 'iaf-mini/v1', issues: { '42': record } });
      fs.writeFileSync(filePath, content);

      let failure: unknown;
      try { createTracker(tmpDir); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(TypeError);
      const message = (failure as Error).message;
      expect(message).toContain('旧任务格式不支持');
      expect(message).toContain('DATA_DIR');
      expect(message).toContain(filePath);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });
  });

  describe('isStalled', () => {
    it('returns false for non-existent issue', () => {
      expect(tracker.isStalled(999)).toBe(false);
    });

    it('returns false for completed issue', () => {
      createRecord(1, IssueState.Completed);
      expect(tracker.isStalled(1)).toBe(false);
    });

    it('returns false for failed issue', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'test error', IssueState.PhaseRunning);
      expect(tracker.isStalled(1)).toBe(false);
    });

    it('returns false for recently updated in-progress issue', () => {
      createRecord(1, IssueState.PhaseRunning);
      expect(tracker.isStalled(1)).toBe(false);
    });

    it('returns true for in-progress issue with stale updatedAt', () => {
      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      createRecord(1, IssueState.PhaseRunning, staleTime);
      expect(tracker.isStalled(1, 5 * 60 * 1000)).toBe(true);
    });

    it('respects custom threshold', () => {
      const staleTime = new Date(Date.now() - 2000).toISOString();
      createRecord(1, IssueState.PhaseRunning, staleTime);
      expect(tracker.isStalled(1, 1000)).toBe(true);
      expect(tracker.isStalled(1, 10000)).toBe(false);
    });
  });

  describe('getDrivableIssues', () => {
    it('returns empty array when no issues exist', () => {
      expect(tracker.getDrivableIssues(3)).toEqual([]);
    });

    it('returns pending issues', () => {
      createRecord(1, IssueState.Pending);
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(1);
      expect(getIssueNumber(result[0])).toBe(1);
    });

    it('returns branch_created issues (e.g. after plan rejection)', () => {
      createRecord(1, IssueState.BranchCreated);
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(1);
      expect(getIssueNumber(result[0])).toBe(1);
    });

    it('returns failed issues under retry limit', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'err', IssueState.PhaseRunning);
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe(IssueState.Failed);
    });

    it('excludes failed issues over retry limit', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'err1', IssueState.PhaseRunning);
      tracker.markFailed(1, 'err2', IssueState.PhaseRunning);
      tracker.markFailed(1, 'err3', IssueState.PhaseRunning);
      tracker.transaction(1, record => { record.run!.retryUsed.setup = 3; });
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(0);
    });

    it('returns stalled in-progress issues', () => {
      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      createRecord(1, IssueState.PhaseRunning, staleTime);
      const result = tracker.getDrivableIssues(3, 5 * 60 * 1000);
      expect(result).toHaveLength(1);
    });

    it('returns phase-done states (e.g. after retryFromPhase)', () => {
      // PhaseDone is always drivable in the new model
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-done-'));
      const t = createTracker(tmpDir2);
      t.create({
        demandSpec: {
          demandId: 'gh-1',
          sourceRef: { source: 'github-issue', externalId: '101', displayId: '1' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        state: IssueState.Pending, branchName: 'feat/1',
      });
      t.updateState(1, IssueState.PhaseDone);
      const result = t.getDrivableIssues(3);
      expect(result, 'PhaseDone should be drivable').toHaveLength(1);
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });

    it('excludes active non-stalled in-progress issues', () => {
      createRecord(1, IssueState.PhaseRunning);
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(0);
    });

    it('excludes completed issues', () => {
      createRecord(1, IssueState.Completed);
      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(0);
    });

    it('returns mixed drivable issues', () => {
      createRecord(1, IssueState.Pending);
      createRecord(2, IssueState.Completed);
      createRecord(3, IssueState.PhaseRunning);
      tracker.markFailed(3, 'err', IssueState.PhaseRunning);

      const result = tracker.getDrivableIssues(3);
      const iids = result.map((r) => getIssueNumber(r)).sort();
      expect(iids).toEqual([1, 3]);
    });
  });

  describe('updateState clears error on completion', () => {
    it('clears lastError and failedAtState when transitioning to Completed', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'some error', IssueState.PhaseRunning);
      expect(tracker.get(1)!.lastError).toBe('some error');
      expect(tracker.get(1)!.failedAtState).toBe(IssueState.PhaseRunning);

      tracker.updateState(1, IssueState.Completed);
      const record = tracker.get(1)!;
      expect(record.state).toBe(IssueState.Completed);
      expect(record.lastError).toBeUndefined();
      expect(record.failedAtState).toBeUndefined();
    });

    it('进入非失败状态时清除失败投影，避免组合出运行中且失败的非法状态', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'some error', IssueState.PhaseRunning);

      tracker.updateState(1, IssueState.PhaseRunning);
      const record = tracker.get(1)!;
      expect(record.state).toBe(IssueState.PhaseRunning);
      expect(record.lastError).toBeUndefined();
    });
  });

  describe('resetFull', () => {
    it('returns false for non-existent issue', () => {
      expect(tracker.resetFull(999)).toBe(false);
    });

    it('resets a failed issue to Pending with zero attempts', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'err', IssueState.PhaseRunning);
      expect(tracker.resetFull(1)).toBe(true);
      const record = tracker.get(1)!;
      expect(record.state).toBe(IssueState.Pending);
      expect(record.attempts).toBe(0);
      expect(record.lastError).toBeUndefined();
      expect(record.failedAtState).toBeUndefined();
      expect(record.sessionId).toBeUndefined();
    });

    it('resets an in-progress issue to Pending', () => {
      createRecord(1, IssueState.PhaseRunning);
      expect(tracker.resetFull(1)).toBe(true);
      const record = tracker.get(1)!;
      expect(record.state).toBe(IssueState.Pending);
      expect(record.attempts).toBe(0);
    });

    it('resets a completed issue to Pending', () => {
      createRecord(1, IssueState.Completed);
      expect(tracker.resetFull(1)).toBe(true);
      expect(tracker.get(1)!.state).toBe(IssueState.Pending);
    });
  });

  describe('resetToPhase', () => {
    it('returns false for non-existent issue', () => {
      expect(tracker.resetToPhase(999, 'plan', PLAN_MODE_PIPELINE)).toBe(false);
    });

    it('resets to BranchCreated for plan phase (plan-mode)', () => {
      createRecord(1, IssueState.PhaseRunning);
      expect(tracker.resetToPhase(1, 'plan', PLAN_MODE_PIPELINE)).toBe(true);
      expect(tracker.get(1)!.state).toBe(IssueState.BranchCreated);
    });

    it('重做 build 时直接指定图入口，不伪造审核已批准状态', () => {
      createRecord(1, IssueState.PhaseRunning);
      expect(tracker.resetToPhase(1, 'build', PLAN_MODE_PIPELINE)).toBe(true);
      expect(tracker.get(1)).toMatchObject({
        state: IssueState.BranchCreated,
        lifecycle: { kind: 'ready' },
        run: { workflow: { generation: 1, entry: 'build' } },
      });
    });

    it('重做 verify 时直接指定图入口，不伪造 build 完成状态', () => {
      createRecord(1, IssueState.Completed);
      expect(tracker.resetToPhase(1, 'verify', PLAN_MODE_PIPELINE)).toBe(true);
      expect(tracker.get(1)).toMatchObject({
        state: IssueState.BranchCreated,
        lifecycle: { kind: 'ready' },
        run: { workflow: { generation: 1, entry: 'verify' } },
      });
    });

    it('returns false for unknown phase name', () => {
      createRecord(1, IssueState.PhaseRunning);
      expect(tracker.resetToPhase(1, 'nonexistent', PLAN_MODE_PIPELINE)).toBe(false);
    });

    it('clears error fields after resetToPhase', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'some error', IssueState.PhaseRunning);
      expect(tracker.resetToPhase(1, 'build', PLAN_MODE_PIPELINE)).toBe(true);
      const record = tracker.get(1)!;
      expect(record.lastError).toBeUndefined();
      expect(record.failedAtState).toBeUndefined();
      expect(record.sessionId).toBeUndefined();
    });
  });

  describe('processingLock', () => {
    it('acquires lock on unlocked issue', () => {
      createRecord(1, IssueState.Pending);
      expect(tracker.acquireProcessingLock(1, 'corr-1')).toBe(true);
      const record = tracker.get(1)!;
      expect(record.processingLock).toBeDefined();
      expect(record.processingLock!.correlationId).toBe('corr-1');
    });

    it('rejects acquire when lock is held by another', () => {
      createRecord(1, IssueState.Pending);
      expect(tracker.acquireProcessingLock(1, 'corr-1')).toBe(true);
      expect(tracker.acquireProcessingLock(1, 'corr-2')).toBe(false);
    });

    it('releases lock when correlationId matches', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.releaseProcessingLock(1, 'corr-1');
      expect(tracker.get(1)!.processingLock).toBeUndefined();
    });

    it('skips release when correlationId does not match', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.releaseProcessingLock(1, 'corr-wrong');
      expect(tracker.get(1)!.processingLock).toBeDefined();
      expect(tracker.get(1)!.processingLock!.correlationId).toBe('corr-1');
    });

    it('clearProcessingLock removes lock unconditionally', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.clearProcessingLock(1);
      expect(tracker.get(1)!.processingLock).toBeUndefined();
    });

    it('getDrivableIssues excludes locked issues', () => {
      createRecord(1, IssueState.Pending);
      createRecord(2, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');

      const result = tracker.getDrivableIssues(3);
      const iids = result.map((r) => getIssueNumber(r));
      expect(iids).toEqual([2]);
    });

    it('getDrivableIssues includes issues with timed-out locks', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');

      // Manually backdate the lock timestamp to exceed timeout
      const raw = JSON.parse(fs.readFileSync(tracker.store.file(1), 'utf-8'));
      raw.record.processingLock.ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fs.writeFileSync(tracker.store.file(1), JSON.stringify(raw, null, 2));
      tracker = createTracker(tmpDir);

      const result = tracker.getDrivableIssues(3);
      expect(result).toHaveLength(1);
    });

    it('acquireProcessingLock overwrites timed-out lock', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-old');

      // Backdate the lock
      const raw = JSON.parse(fs.readFileSync(tracker.store.file(1), 'utf-8'));
      raw.record.processingLock.ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fs.writeFileSync(tracker.store.file(1), JSON.stringify(raw, null, 2));
      tracker = createTracker(tmpDir);

      expect(tracker.acquireProcessingLock(1, 'corr-new')).toBe(true);
      expect(tracker.get(1)!.processingLock!.correlationId).toBe('corr-new');
    });

    it('resetFull clears processingLock', () => {
      createRecord(1, IssueState.Pending);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.resetFull(1);
      expect(tracker.get(1)!.processingLock).toBeUndefined();
    });

    it('resetForRetry clears processingLock', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.markFailed(1, 'err', IssueState.PhaseRunning);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.resetForRetry(1);
      expect(tracker.get(1)!.processingLock).toBeUndefined();
    });

    it('pauseIssue clears processingLock', () => {
      createRecord(1, IssueState.PhaseRunning);
      tracker.acquireProcessingLock(1, 'corr-1');
      tracker.pauseIssue(1, 'plan');
      expect(tracker.get(1)!.processingLock).toBeUndefined();
    });

    it('returns false for non-existent issue', () => {
      expect(tracker.acquireProcessingLock(999, 'corr-1')).toBe(false);
    });
  });
});
