import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import type { IssueLifecycle } from '../../src/tracker/IssueLifecycle.js';
import { getIssueNumber } from '../../src/tracker/IssueRecordHelper.js';
import { retryAttempts } from '../../src/tracker/IssueRecord.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';

const definitions = () => new Map([['plan-mode', PLAN_MODE_PIPELINE]]);

describe('IssueTracker', () => {
  let directory: string;
  let tracker: IssueTracker;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
    tracker = new IssueTracker(directory, definitions());
  });

  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  function createRecord(number: number, lifecycle: IssueLifecycle = { kind: 'pending' }, updatedAt?: string) {
    tracker.create({
      lifecycle,
      demandSpec: {
        demandId: `gh-${number}`,
        sourceRef: { source: 'github-issue', externalId: `${number + 100}`, displayId: `${number}` },
        title: `Issue ${number}`,
        description: '',
        createdAt: '2024-01-01T00:00:00Z',
      },
      branchName: `feat/issue-${number}`,
    });
    if (updatedAt) {
      const file = tracker.store.file(number);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.record.updatedAt = updatedAt;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      tracker = new IssueTracker(directory, definitions());
    }
  }

  describe('isStalled', () => {
    it('不存在、完成和失败任务均不会判定为停滞', () => {
      expect(tracker.isStalled(999)).toBe(false);
      createRecord(1, { kind: 'completed' });
      createRecord(2, { kind: 'failed', phase: 'build', retry: 'manual', error: { message: '错误', retryable: 'hard-no-auto' } });
      expect(tracker.isStalled(1)).toBe(false);
      expect(tracker.isStalled(2)).toBe(false);
    });

    it('仅把超过阈值的活动生命周期判定为停滞', () => {
      createRecord(1, { kind: 'running', phase: 'build' });
      createRecord(2, { kind: 'running', phase: 'build' }, new Date(Date.now() - 10 * 60 * 1000).toISOString());
      expect(tracker.isStalled(1)).toBe(false);
      expect(tracker.isStalled(2, 5 * 60 * 1000)).toBe(true);
    });
  });

  describe('getDrivableIssues', () => {
    it('返回 pending、ready 和预算内自动失败任务', () => {
      createRecord(1, { kind: 'pending' });
      createRecord(2, { kind: 'ready' });
      createRecord(3, { kind: 'running', phase: 'build' });
      tracker.markFailed(3, 'err');
      createRecord(4, { kind: 'completed' });
      expect(tracker.getDrivableIssues(3).map(getIssueNumber).sort()).toEqual([1, 2, 3]);
      expect(tracker.get(3)?.lifecycle.kind).toBe('failed');
    });

    it('排除耗尽预算和仍持有有效处理锁的任务', () => {
      createRecord(1, { kind: 'failed', phase: 'build', retry: 'auto', error: { message: 'err', retryable: 'hard' } });
      tracker.transaction(1, record => { record.run.retryUsed.build = 3; });
      createRecord(2);
      tracker.acquireProcessingLock(2, 'corr-2');
      expect(tracker.getDrivableIssues(3)).toEqual([]);
    });

    it('活跃输出超时不提前占用重试预算', () => {
      createRecord(1, { kind: 'running', phase: 'build' });
      tracker.markFailedSoft(1, '仍在输出时超时');
      expect(tracker.get(1)).toMatchObject({
        lifecycle: { kind: 'failed', phase: 'build', retry: 'auto' },
        run: { retryUsed: {} },
      });
      expect(tracker.getDrivableIssues(1)).toHaveLength(1);
    });
  });

  describe('生命周期重置', () => {
    it('完整重做创建 pending 生命周期并清空本轮预算', () => {
      createRecord(1, { kind: 'running', phase: 'build' });
      tracker.markFailed(1, 'err');
      expect(tracker.resetFull(1)).toBe(true);
      const record = tracker.get(1)!;
      expect(record.lifecycle).toEqual({ kind: 'pending' });
      expect(retryAttempts(record)).toBe(0);
      expect(record.phaseHistory).toEqual([]);
    });

    it('指定阶段重做只设置新图入口和 ready 生命周期', () => {
      createRecord(1, { kind: 'completed' });
      expect(tracker.resetToPhase(1, 'verify', PLAN_MODE_PIPELINE)).toBe(true);
      expect(tracker.get(1)).toMatchObject({
        lifecycle: { kind: 'ready' },
        run: { workflow: { generation: 1, entry: 'verify' } },
      });
    });

    it('拒绝不存在的任务和阶段', () => {
      expect(tracker.resetFull(999)).toBe(false);
      createRecord(1, { kind: 'running', phase: 'build' });
      expect(tracker.resetToPhase(1, 'nonexistent', PLAN_MODE_PIPELINE)).toBe(false);
    });
  });

  describe('processingLock', () => {
    it('获取、匹配释放和强制清理均保持幂等', () => {
      createRecord(1);
      expect(tracker.acquireProcessingLock(1, 'corr-1')).toBe(true);
      expect(tracker.acquireProcessingLock(1, 'corr-2')).toBe(false);
      tracker.releaseProcessingLock(1, 'wrong');
      expect(tracker.get(1)?.processingLock?.correlationId).toBe('corr-1');
      tracker.releaseProcessingLock(1, 'corr-1');
      expect(tracker.get(1)?.processingLock).toBeUndefined();
    });

    it('超时锁可以被新的执行身份覆盖', () => {
      createRecord(1);
      tracker.acquireProcessingLock(1, 'old');
      const file = tracker.store.file(1);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.record.processingLock.ts = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      tracker = new IssueTracker(directory, definitions());
      expect(tracker.acquireProcessingLock(1, 'new')).toBe(true);
      expect(tracker.get(1)?.processingLock?.correlationId).toBe('new');
    });

    it('暂停和重试会清除处理锁', () => {
      createRecord(1, { kind: 'running', phase: 'plan' });
      tracker.acquireProcessingLock(1, 'corr');
      tracker.pauseIssue(1, 'plan');
      expect(tracker.get(1)?.processingLock).toBeUndefined();

      tracker.transaction(1, record => {
        record.lifecycle = { kind: 'failed', phase: 'plan', retry: 'manual', error: { message: 'err', retryable: 'hard-no-auto' } };
        record.processingLock = { correlationId: 'corr-2', ts: new Date().toISOString() };
      });
      expect(tracker.resetForRetry(1)).toBe(true);
      expect(tracker.get(1)?.processingLock).toBeUndefined();
    });
  });
});
