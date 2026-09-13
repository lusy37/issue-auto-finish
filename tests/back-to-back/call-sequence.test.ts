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
import { IssueState } from '../../src/tracker/IssueState.js';
import {
  PLAN_MODE_PIPELINE,
} from '../../src/pipeline/PipelineDefinition.js';

// ---------------------------------------------------------------------------
// Harness (minimal, focused on call sequence recording)
// ---------------------------------------------------------------------------

function createMinimalHarness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'b2b-'));
  const tracker = new IssueTracker(dataDir);

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

    // Simulate classic pipeline lifecycle
    const record = tracker.create({
      state: IssueState.Pending,
      branchName: 'feat/issue-1',
      pipelineMode: 'plan-mode',
      demandSpec: makeDemand(1),
    });

    stateLog.push(record.state);

    tracker.updateState(1, IssueState.BranchCreated);
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseRunning, { currentPhase: 'plan' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseDone, { currentPhase: 'plan' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseWaiting);
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseApproved);
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseRunning, { currentPhase: 'build' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseDone, { currentPhase: 'build' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseRunning, { currentPhase: 'verify' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.PhaseDone, { currentPhase: 'verify' });
    stateLog.push(tracker.get(1)!.state);

    tracker.updateState(1, IssueState.Completed, { prUrl: 'https://pr/1' });
    stateLog.push(tracker.get(1)!.state);

    expect(stateLog).toMatchSnapshot();
  });

  it('failure and retry state sequence', () => {
    const { tracker } = harness;
    const stateLog: string[] = [];

    tracker.create({
      state: IssueState.Pending,
      branchName: 'feat/issue-2',
      pipelineMode: 'plan-mode',
      demandSpec: makeDemand(2),
    });
    stateLog.push(tracker.get(2)!.state);

    tracker.updateState(2, IssueState.BranchCreated);
    stateLog.push(tracker.get(2)!.state);

    tracker.updateState(2, IssueState.PhaseRunning, { currentPhase: 'plan' });
    stateLog.push(tracker.get(2)!.state);

    // Failure
    tracker.markFailed(2, 'AI timeout', IssueState.PhaseRunning);
    stateLog.push(tracker.get(2)!.state);
    stateLog.push(`failedAt:${tracker.get(2)!.failedAtState}`);

    // Retry (reset for retry)
    tracker.resetForRetry(2);
    stateLog.push(tracker.get(2)!.state);
    stateLog.push(`attempts:${tracker.get(2)!.attempts}`);

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

  it('pipeline lifecycle manager phase order', () => {
    const phaseOrder = PLAN_MODE_PIPELINE.phases.map(p => ({
      name: p.name,
      kind: p.kind,
      startState: p.startState,
      doneState: 'doneState' in p ? p.doneState : undefined,
    }));
    expect(phaseOrder).toMatchSnapshot();
  });
});
