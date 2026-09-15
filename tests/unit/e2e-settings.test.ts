import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { buildPlanModePipeline, createLifecycleManager } from '../../src/pipeline/PipelineMetadata.js';
import { isE2eEnabledForIssue } from '../../src/e2e/E2eSettings.js';
import { createTestConfig } from '../helpers/mock-factories.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-e2e-policy-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
it.each([false, true])('验收要求 %s 跨重启保持，完整重做才采用新配置', enabled => {
  const config = createTestConfig(); config.e2e.enabled = enabled;
  const pipeline = buildPlanModePipeline({ e2eEnabled: enabled });
  const managers = new Map([[pipeline.mode, createLifecycleManager(pipeline)]]);
  const tracker = new IssueTracker(directory, managers);
  tracker.create({ state: IssueState.Pending, branchName: 'feat/issue-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '需求', description: '验证开关', createdAt: new Date().toISOString() } });
  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(enabled);
  tracker.initPhaseProgress(1, pipeline);
  config.e2e.enabled = !enabled;
  const restored = new IssueTracker(directory, managers);
  expect(isE2eEnabledForIssue(1, restored, config)).toBe(enabled);
  expect(Object.hasOwn(restored.get(1)!.phaseProgress!, 'uat')).toBe(enabled);
  restored.resetFull(1);
  expect(isE2eEnabledForIssue(1, restored, config)).toBe(!enabled);
});
it('本轮阶段包含 UAT 时，全局关闭不会绕过验收', () => {
  const config = createTestConfig(); config.e2e.enabled = false;
  const pipeline = buildPlanModePipeline({ e2eEnabled: true });
  const tracker = new IssueTracker(directory, new Map([[pipeline.mode, createLifecycleManager(pipeline)]]));
  tracker.create({ state: IssueState.PhaseRunning, branchName: 'feat/issue-1', currentPhase: 'uat', phaseProgress: { uat: { status: 'in_progress' } }, demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '已有验收', description: '保持原要求', createdAt: new Date().toISOString() } });
  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(true);
});
