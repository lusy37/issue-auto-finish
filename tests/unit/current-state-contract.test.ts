import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE, createLifecycleManager } from '../../src/pipeline/PipelineMetadata.js';

let directory: string;
const managers = () => new Map([['plan-mode', createLifecycleManager(PLAN_MODE_PIPELINE)]]);
const input = (pipelineMode?: string) => ({
  state: IssueState.Pending, branchName: 'feat/issue-1', pipelineMode,
  demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' }, title: '需求', description: '', createdAt: new Date().toISOString() },
});
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-state-contract-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

it.each([undefined, null, { kind: 'unknown' }, { kind: 'running' }, { kind: 'gate-waiting', phaseId: 'review' }])('拒绝缺失或无效的快照 %j，原文件保持不变', state => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  const file = tracker.store.file(1);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.record.orchestrationState = state;
  const content = JSON.stringify(stored);
  fs.writeFileSync(file, content);
  expect(() => new IssueTracker(directory, managers())).toThrow('编排状态快照缺失或无效');
  expect(() => new IssueTracker(directory, managers())).toThrow(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

it.each(Object.values(IssueState))('当前状态 %s 写入后可完整恢复', state => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  tracker.updateState(1, state, { currentPhase: 'review', pausedAtPhase: 'review', lastError: '测试错误' });
  const record = tracker.get(1)!;
  expect(new IssueTracker(directory, managers()).get(1)?.orchestrationState).toEqual(record.orchestrationState);
});

it('未初始化任务使用默认流程，未知模式或未注册默认流程直接报错', () => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  expect(tracker.getAllActive()).toHaveLength(1);
  expect(() => new IssueTracker(directory, new Map()).getAllActive()).toThrow('任务流水线未注册');
  tracker.updateState(1, IssueState.Pending, { pipelineMode: 'unknown-mode' });
  expect(() => tracker.getAllActive()).toThrow('unknown-mode');
});
