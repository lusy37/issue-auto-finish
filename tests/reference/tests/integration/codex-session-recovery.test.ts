import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../../../src/tracker/IssueTracker.js';
import { IssueState } from '../../../../src/tracker/IssueState.js';
import { getPipelineDef } from '../../../../src/pipeline/PipelineMetadata.js';
import { TrackerStateStore } from '../../orchestrator/TrackerStateStore.js';

let dir: string;
let tracker: IssueTracker;
const demand = { demandId: 'gh-42', title: '恢复测试', description: '生成计划', sourceRef: { source: 'github-issue' as const, externalId: '42', displayId: '42' }, createdAt: new Date().toISOString() };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-codex-recovery-'));
  const def = getPipelineDef('plan-mode')!;
  tracker = new IssueTracker(dir, new Map([['plan-mode', def]]));
  tracker.create({ demandSpec: demand, state: IssueState.PhaseRunning, branchName: 'feat/42', currentPhase: 'plan', pipelineMode: 'plan-mode' });
  tracker.initPhaseProgress(42, def);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function legacyProgress(status: 'failed' | 'completed') {
  const progress: { phases: { plan: { status: string; sessionId?: string } } } = {
    phases: { plan: { status, sessionId: 'codex:thread-42' } },
  };
  return {
    readProgress: () => progress,
    updatePhaseProgress: (_phase: string, next: string, _error?: string, options?: { preserveSessionId?: boolean }) => {
      progress.phases.plan.status = next;
      if (!options?.preserveSessionId) progress.phases.plan.sessionId = undefined;
    },
  };
}

it('迁移前适配器在未完成阶段保留聚合会话标识', () => {
  tracker.transaction(42, record => { record.phaseProgress!.plan = { status: 'failed', sessionId: 'codex:thread-42' }; });
  const store = new TrackerStateStore(tracker, legacyProgress('failed') as never);

  store.transitionToRunning(42, 'plan', new Date().toISOString());

  expect(tracker.get(42)!.phaseProgress!.plan).toMatchObject({ status: 'in_progress', sessionId: 'codex:thread-42' });
});

it('迁移前适配器重跑已完成阶段时清除旧会话标识', () => {
  tracker.transaction(42, record => { record.phaseProgress!.plan = { status: 'completed', sessionId: 'codex:thread-42' }; });
  const store = new TrackerStateStore(tracker, legacyProgress('completed') as never);

  store.transitionToRunning(42, 'plan', new Date().toISOString());

  expect(tracker.get(42)!.phaseProgress!.plan.sessionId).toBeUndefined();
});
