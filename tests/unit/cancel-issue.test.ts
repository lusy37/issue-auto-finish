import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reviewApi } from '../helpers/review-api.js';
import { newTracker } from '../helpers/dag-repository.js';
import { GitHubClient } from '../../src/clients/GitHubClient.js';
let f: Awaited<ReturnType<typeof reviewApi>>;
beforeEach(async () => { f = await reviewApi(); });
afterEach(async () => { await f.close(); });
describe('持久化停止与继续', () => {
  it('先保存取消状态和停止意图，再操作平台标签', async () => {
    f.github.removeLabelsWithPrefix.mockImplementation(async () => { expect(newTracker(f.data).get(42)!.run!.stopIntent!.kind).toBe('cancel'); });
    await f.orchestrator.cancelIssue(42);
    expect(f.tracker.get(42)!.lifecycle).toEqual({ kind: 'cancelled' });
    expect(f.github.removeLabelsWithPrefix).toHaveBeenCalledWith(42, 'auto-finish');
  });
  it('未知 Issue 不能取消', async () => { await expect(f.orchestrator.cancelIssue(999)).rejects.toThrow('not found'); });
  it('平台失败仍保留已持久化的取消状态', async () => { f.github.removeLabelsWithPrefix.mockRejectedValue(new Error('平台离线')); await expect(f.orchestrator.cancelIssue(42)).rejects.toThrow('平台离线'); expect(f.tracker.get(42)!.lifecycle).toEqual({ kind: 'cancelled' }); });
  it('取消不丢失交付身份或删除远端分支', async () => {
    f.tracker.transaction(42, record => { record.run!.delivery = { repository: 'test/project', issueNumber: 42, sourceBranch: 'iaf-42', targetBranch: 'master', marker: 'marker', creation: 'confirmed', prNumber: 8 }; });
    await f.orchestrator.cancelIssue(42); expect(f.tracker.get(42)!.run!.delivery!.prNumber).toBe(8);
  });
  it('暂停后显式继续保持原计划版本和重试预算', async () => { f.tracker.transaction(42, record => { record.run!.retryUsed.build = 2; }); await f.orchestrator.abortIssue(42); expect(f.tracker.get(42)!.run!.stopIntent!.kind).toBe('pause'); f.orchestrator.continueIssue(42); expect(f.tracker.get(42)!.run!.stopIntent).toBeUndefined(); expect(f.tracker.get(42)!.run!.retryUsed.build).toBe(2); });
  it('非暂停状态不能继续', () => { expect(() => f.orchestrator.continueIssue(42)).toThrow(); });
  it('中止等待进程退出竞态后成功完成', async () => {
    vi.useFakeTimers();
    try {
      f.tracker.transaction(42, record => {
        record.run!.calls.delayed = {
          identity: { issueNumber: 42, planRevision: 1, buildGeneration: 0, dispatchId: 'old', taskId: '$phase:plan', attemptNo: 1, callId: 'delayed' },
          workDir: f.directory,
          status: 'running',
          pid: process.pid,
        };
      });
      const pending = f.orchestrator.abortIssue(42);
      setTimeout(() => f.tracker.transaction(42, record => { record.run!.calls.delayed.status = 'exited'; }), 100);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(f.tracker.get(42)!.lifecycle).toEqual({ kind: 'paused', phase: 'review' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('旧调用仍活着时保存停止意图但拒绝继续与清理', async () => {
    vi.useFakeTimers();
    try {
      f.tracker.transaction(42, record => { record.run!.calls.alive = { identity: { issueNumber: 42, planRevision: 1, buildGeneration: 0, dispatchId: 'old', taskId: '$phase:plan', attemptNo: 1, callId: 'alive' }, workDir: f.directory, status: 'running', pid: process.pid }; });
      const rejection = expect(f.orchestrator.abortIssue(42)).rejects.toThrow('尚未退出');
      await vi.advanceTimersByTimeAsync(5000);
      await rejection; expect(f.tracker.get(42)!.run!.stopIntent!.kind).toBe('pause'); expect(() => f.orchestrator.continueIssue(42)).toThrow('尚未退出');
    } finally {
      vi.useRealTimers();
    }
  });
  it('单次重做先等待停止，且保留构建重试预算', async () => { f.tracker.transaction(42, record => { record.lifecycle = { kind: 'running', phase: 'build' }; record.run.retryUsed.build = 1; }); await f.orchestrator.redoPhase(42); expect(f.tracker.get(42)!.run.retryUsed.build).toBe(1); expect(f.tracker.get(42)!.run.stopIntent).toBeUndefined(); });
});

describe('GitHubClient.removeLabelsWithPrefix', () => {
  it('精确过滤：移除 auto-finish 和 auto-finish:* 前缀，保留无关标签', async () => {
    const config = {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    };
    const client = new GitHubClient(config);

    // Mock fetch
    const issueLabels = ['auto-finish', 'auto-finish:processing', 'auto-finish:done', 'bug', 'priority:high'];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 100, labels: issueLabels }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));

    vi.stubGlobal('fetch', mockFetch);

    await client.removeLabelsWithPrefix(100, 'auto-finish');

    // 第二次 fetch 调用是 updateIssueLabels
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const updateCall = mockFetch.mock.calls[1];
    const body = JSON.parse(updateCall[1].body);
    expect(body.labels).toEqual(['bug', 'priority:high']);

    vi.unstubAllGlobals();
  });

  it('没有匹配标签时不调用 updateIssueLabels', async () => {
    const config = {
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    };
    const client = new GitHubClient(config);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 100, labels: ['bug', 'feature'] }), { headers: { 'content-type': 'application/json' } }));

    vi.stubGlobal('fetch', mockFetch);

    await client.removeLabelsWithPrefix(100, 'auto-finish');

    // 只调用了 getIssueDetail，没有调用 updateIssueLabels
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
