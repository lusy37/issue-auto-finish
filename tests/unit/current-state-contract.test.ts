import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { readIssueLifecycle, writeIssueLifecycle, type IssueLifecycle } from '../../src/tracker/IssueLifecycle.js';
import { PLAN_MODE_PIPELINE, createLifecycleManager } from '../../src/pipeline/PipelineMetadata.js';

let directory: string;
const managers = () => new Map([['plan-mode', createLifecycleManager(PLAN_MODE_PIPELINE)]]);
const input = (pipelineMode?: string) => ({
  state: IssueState.Pending, branchName: 'feat/issue-1', pipelineMode,
  demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue' as const, externalId: '1', displayId: '1' }, title: '需求', description: '', createdAt: new Date().toISOString() },
});
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-state-contract-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

it.each([
  undefined,
  null,
  { kind: 'unknown' },
  { kind: 'running' },
  { kind: 'waiting', phase: 'unknown' },
  { kind: 'failed', retry: 'auto' },
])('拒绝缺失或无效的 lifecycle %j，原文件保持不变', lifecycle => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  const file = tracker.store.file(1);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.record.lifecycle = lifecycle;
  const content = JSON.stringify(stored);
  fs.writeFileSync(file, content);
  expect(() => new IssueTracker(directory, managers())).toThrow(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

it.each<IssueLifecycle>([
  { kind: 'pending' },
  { kind: 'skipped' },
  { kind: 'ready' },
  { kind: 'running', phase: 'build' },
  { kind: 'waiting', phase: 'review', planRevision: 1 },
  { kind: 'paused', phase: 'verify' },
  { kind: 'failed', phase: 'build', retry: 'manual', error: { message: '测试错误', retryable: 'hard-no-auto' } },
  { kind: 'delivering' },
  { kind: 'completed' },
  { kind: 'cancelled' },
])('生命周期 $kind 写入后可完整恢复', lifecycle => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  tracker.transaction(1, record => { writeIssueLifecycle(record, lifecycle); });
  expect(readIssueLifecycle(new IssueTracker(directory, managers()).get(1)!)).toEqual(lifecycle);
});

it('v4 文件只持久化 lifecycle，不保存旧状态和 orchestrationState', () => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input());
  const stored = JSON.parse(fs.readFileSync(tracker.store.file(1), 'utf8'));
  expect(stored.format).toBe('iaf-mini/issue-run/v4-langgraph');
  expect(stored.record.lifecycle).toEqual({ kind: 'pending' });
  for (const key of ['state', 'currentPhase', 'pausedAtPhase', 'attempts', 'lastError', 'failedAtState', 'lastErrorRetryable', 'orchestrationState']) {
    expect(stored.record).not.toHaveProperty(key);
  }
});

it('未初始化任务不依赖展示状态映射器，未知模式保持可读取', () => {
  const tracker = new IssueTracker(directory, managers());
  tracker.create(input('unknown-mode'));
  expect(tracker.getAllActive()).toHaveLength(1);
  expect(new IssueTracker(directory, new Map()).getAllActive()).toHaveLength(1);
});
