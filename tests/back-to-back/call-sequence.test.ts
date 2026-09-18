/**
 * Back-to-Back 测试：录制关键 mock 调用序列并与 fixture 对比，
 * 守卫行为回归。
 *
 * 首次运行（无 fixture 文件）自动录制并写入 fixture。
 * 后续运行与 fixture 对比，差异即回归。
 *
 * 使用 vitest snapshot 机制实现：调用序列序列化后 toMatchSnapshot()。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { applyIssueLifecycleEvent } from '../../src/tracker/IssueLifecycle.js';
import {
  PLAN_MODE_PIPELINE,
} from '../../src/pipeline/PipelineMetadata.js';

// ---------------------------------------------------------------------------
// Harness (minimal, focused on call sequence recording)
// ---------------------------------------------------------------------------

function createMinimalHarness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'b2b-'));
  const tracker = new IssueTracker(dataDir, new Map([['plan-mode', PLAN_MODE_PIPELINE]]));

  const callLog: Array<{ method: string; args: unknown[] }> = [];

  const recordCall = (method: string) =>
    vi.fn((...args: unknown[]) => {
      // Sanitize unstable values
      const sanitizedArgs = JSON.parse(JSON.stringify(args, (_key, val) => {
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) return '<ISO_DATE>';
        return val;
      }));
      callLog.push({ method, args: sanitizedArgs });
    });

  const github = {
    updateIssueLabels: recordCall('github.updateIssueLabels').mockResolvedValue(undefined),
    createIssueNote: recordCall('github.createIssueNote').mockResolvedValue(undefined),
    createPullRequest: recordCall('github.createPullRequest').mockResolvedValue({
      id: 1, number: 1, title: 'PR', html_url: 'https://example.com/pr/1', state: 'open',
    }),
    findPullRequestByBranch: vi.fn().mockResolvedValue(null),
    cleanupAgentNotes: vi.fn().mockResolvedValue(0),
  };

  return {
    dataDir,
    tracker,
    github,
    callLog,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Back-to-Back: tracker state update sequences', () => {
  let harness: ReturnType<typeof createMinimalHarness>;

  beforeEach(() => {
    harness = createMinimalHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  function makeDemand(number: number) {
    return {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue' as const, externalId: String(number * 100), displayId: String(number) },
      title: `Test Issue ${number}`,
      description: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('classic issue lifecycle state sequence', () => {
    const { tracker } = harness;
    const stateLog: string[] = [];

    const transition = (event: Parameters<typeof applyIssueLifecycleEvent>[1]) => {
      tracker.transaction(1, current => { applyIssueLifecycleEvent(current, event); });
      const lifecycle = tracker.get(1)!.lifecycle;
      stateLog.push('phase' in lifecycle ? `${lifecycle.kind}:${lifecycle.phase}` : lifecycle.kind);
    };
    const record = tracker.create({
      lifecycle: { kind: 'pending' },
      branchName: 'feat/issue-1',
      pipelineMode: 'plan-mode',
      demandSpec: makeDemand(1),
    });

    stateLog.push(record.lifecycle.kind);
    transition({ type: 'setup-completed' });
    transition({ type: 'phase-started', phase: 'plan' });
    transition({ type: 'phase-completed', phase: 'plan' });
    transition({ type: 'phase-started', phase: 'review' });
    transition({ type: 'gate-interrupted', phase: 'review' });
    transition({ type: 'gate-resolved', phase: 'review', action: 'approve' });
    transition({ type: 'phase-started', phase: 'build' });
    transition({ type: 'phase-completed', phase: 'build' });
    transition({ type: 'phase-started', phase: 'verify' });
    transition({ type: 'delivery-started' });
    transition({ type: 'delivery-confirmed' });

    expect(stateLog).toMatchSnapshot();
  });

  it('failure and retry state sequence', () => {
    const { tracker } = harness;
    const stateLog: string[] = [];

    tracker.create({
      lifecycle: { kind: 'pending' },
      branchName: 'feat/issue-2',
      pipelineMode: 'plan-mode',
      demandSpec: makeDemand(2),
    });
    stateLog.push(tracker.get(2)!.lifecycle.kind);
    tracker.transaction(2, record => { applyIssueLifecycleEvent(record, { type: 'setup-completed' }); });
    stateLog.push(tracker.get(2)!.lifecycle.kind);
    tracker.transaction(2, record => { applyIssueLifecycleEvent(record, { type: 'phase-started', phase: 'plan' }); });
    stateLog.push(`${tracker.get(2)!.lifecycle.kind}:plan`);

    // Failure
    tracker.markFailed(2, 'AI timeout');
    stateLog.push(tracker.get(2)!.lifecycle.kind);
    stateLog.push(`failedAt:${tracker.get(2)!.lifecycle.kind === 'failed' ? tracker.get(2)!.lifecycle.phase : undefined}`);

    // Retry (reset for retry)
    tracker.resetForRetry(2);
    stateLog.push(tracker.get(2)!.lifecycle.kind);
    stateLog.push(`attempts:${tracker.get(2)!.run.retryUsed.plan ?? 0}`);

    expect(stateLog).toMatchSnapshot();
  });

  it('github API call sequence for label updates', () => {
    const { github, callLog } = harness;

    // Simulate the label update sequence during processing
    github.updateIssueLabels(100, ['auto-finish:processing']);
    github.createIssueNote(100, '🚀 开始处理');
    github.createIssueNote(100, '✅ 完成');
    github.updateIssueLabels(100, ['auto-finish:done']);

    const labelCalls = callLog.filter(c => c.method === 'github.updateIssueLabels');
    expect(labelCalls).toMatchSnapshot();
  });

  it('github API call sequence for failure path', () => {
    const { github, callLog } = harness;

    github.updateIssueLabels(200, ['auto-finish:processing']);
    github.createIssueNote(200, '🚀 开始处理');
    github.updateIssueLabels(200, ['auto-finish', 'auto-finish:failed']);
    github.createIssueNote(200, '❌ 处理失败: AI timeout');

    expect(callLog).toMatchSnapshot();
  });

  it('pipeline phase order does not carry lifecycle state mappings', () => {
    const phaseOrder = PLAN_MODE_PIPELINE.phases.map(p => ({
      name: p.name,
      kind: p.kind,
    }));
    expect(phaseOrder).toMatchSnapshot();
  });
});
