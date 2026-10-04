import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { buildPlanModePipeline } from '../../src/pipeline/PipelineMetadata.js';
import { isE2eEnabledForIssue } from '../../src/e2e/E2eSettings.js';
import { createTestConfig } from '../helpers/mock-factories.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-e2e-policy-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
it.each([false, true])('验收要求 %s 跨重启保持，完整重做才采用新配置', enabled => {
  const config = createTestConfig(); config.e2e.enabled = enabled;
  const pipeline = buildPlanModePipeline({ e2eEnabled: enabled });
  const tracker = new IssueTracker(directory, pipeline);
  tracker.create({ lifecycle: { kind: 'pending' }, branchName: 'feat/issue-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '需求', description: '验证开关', createdAt: new Date().toISOString() } });
  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(enabled);
  tracker.initPhaseProgress(1, pipeline);
  config.e2e.enabled = !enabled;
  const restored = new IssueTracker(directory, pipeline);
  expect(isE2eEnabledForIssue(1, restored, config)).toBe(enabled);
  expect(restored.get(1)!.run!.workflow.definition?.phaseIds.includes('uat')).toBe(enabled);
  expect(Object.hasOwn(restored.get(1)!.phaseProgress!, 'uat')).toBe(enabled);
  restored.resetFull(1);
  expect(isE2eEnabledForIssue(1, restored, config)).toBe(!enabled);
});
it('本轮阶段包含 UAT 时，全局关闭不会绕过验收', () => {
  const config = createTestConfig(); config.e2e.enabled = false;
  const pipeline = buildPlanModePipeline({ e2eEnabled: true });
  const tracker = new IssueTracker(directory, pipeline);
  tracker.create({ lifecycle: { kind: 'running', phase: 'uat' }, branchName: 'feat/issue-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '已有验收', description: '保持原要求', createdAt: new Date().toISOString() } });
  tracker.initPhaseProgress(1, pipeline);
  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(true);
});

it('阶段定义固化后，展示进度和全局配置都不能改写本轮 UAT 要求', () => {
  const config = createTestConfig(); config.e2e.enabled = true;
  const disabled = buildPlanModePipeline({ e2eEnabled: false });
  const enabled = buildPlanModePipeline({ e2eEnabled: true });
  const tracker = new IssueTracker(directory, disabled);
  tracker.create({ lifecycle: { kind: 'pending' }, branchName: 'feat/issue-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '不可变流程', description: '校验阶段定义', createdAt: new Date().toISOString() } });
  tracker.initPhaseProgress(1, disabled);
  tracker.transaction(1, record => { record.phaseProgress!.uat = { status: 'in_progress' }; });

  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(false);
  expect(() => tracker.initPhaseProgress(1, enabled)).toThrow('本轮工作流阶段定义已固化');
});

it('尚未初始化阶段定义时不从 phaseProgress 推断 UAT 配置', () => {
  const config = createTestConfig(); config.e2e.enabled = false;
  const pipeline = buildPlanModePipeline({ e2eEnabled: true });
  const tracker = new IssueTracker(directory, pipeline);
  tracker.create({ lifecycle: { kind: 'pending' }, branchName: 'feat/issue-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '未初始化任务', description: '忽略展示残留', createdAt: new Date().toISOString() } });
  tracker.transaction(1, record => { record.phaseProgress = { uat: { status: 'pending' } }; });

  expect(tracker.get(1)!.run!.workflow.definition).toBeUndefined();
  expect(isE2eEnabledForIssue(1, tracker, config)).toBe(false);
});
