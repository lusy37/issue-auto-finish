import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitOperations } from '../../src/git/GitOperations.js';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import { TaskGraphExecutor } from '../../src/dag/TaskGraphExecutor.js';
import type { AIRunner, RunOptions, RunResult } from '../../src/ai-runner/AIRunner.js';
import { graphFixture, graphDeps, task, git, newTracker } from '../helpers/dag-repository.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const runner = (run: (options: RunOptions) => Promise<RunResult>): AIRunner => ({ run, killAll() {}, killByWorkDir() { return 0; } });
const success = { success: true, output: '完成', exitCode: 0 };

describe('真实 Git 上的任务图与恢复协议', () => {
  it('A/B 同时执行，C 只在两者确认合并后执行；结果只有一个集成分支', async () => {
    const fixture = graphFixture(); directories.push(fixture.directory);
    let active = 0, maxActive = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    const ai = runner(async options => {
      active++; maxActive = Math.max(maxActive, active);
      const id = options.identity!.taskId;
      if (id === 'c') {
        expect(fixture.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
        expect(fixture.tracker.get(1)!.run!.tasks.b.status).toBe('merged');
        expect(fs.existsSync(path.join(options.workDir, 'a.txt'))).toBe(true);
        expect(fs.existsSync(path.join(options.workDir, 'b.txt'))).toBe(true);
      }
      if (id !== 'c') { if (active === 2) release(); await bothStarted; }
      fs.writeFileSync(path.join(options.workDir, `${id}.txt`), id);
      active--; return success;
    });
    await new TaskGraphExecutor(graphDeps(fixture, ai)).execute();
    expect(maxActive).toBe(2);
    expect(Object.values(fixture.tracker.get(1)!.run!.tasks).every(t => t.status === 'merged' && !!t.success && !!t.merge?.integrationAfter)).toBe(true);
    expect(git(fixture.integration, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(fixture.integration, 'c.txt'), 'utf8')).toBe('c');
  });
  it('AI 中间提交后最终失败不能合入；失败后普通重试保留已经确认的任务', async () => {
    const fixture = graphFixture([task('a'), task('b', ['a'])]); directories.push(fixture.directory);
    let fail = true;
    const calls: string[] = [];
    const ai = runner(async options => {
      const id = options.identity!.taskId; calls.push(id);
      fs.writeFileSync(path.join(options.workDir, `${id}.txt`), id);
      if (id === 'b' && fail) {
        git(options.workDir, 'add', '.'); git(options.workDir, 'commit', '-m', 'AI 中间提交');
        return { ...success, success: false, errorMessage: '模型最终失败' };
      }
      return success;
    });
    await expect(new TaskGraphExecutor(graphDeps(fixture, ai)).execute()).rejects.toThrow('模型最终失败');
    expect(fixture.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
    expect(fixture.tracker.get(1)!.run!.tasks.b.success).toBeUndefined();
    expect(fs.existsSync(path.join(fixture.integration, 'b.txt'))).toBe(false);
    fail = false;
    fixture.tracker.transaction(1, record => { record.run!.dispatchId = 'retry'; });
    await new TaskGraphExecutor(graphDeps(fixture, ai)).execute();
    expect(calls).toEqual(['a', 'b', 'b']);
  });
  it('无变化任务只有明确成功凭证才能完成', async () => {
    const fixture = graphFixture([task('a')]); directories.push(fixture.directory);
    const executor = new TaskGraphExecutor(graphDeps(fixture, runner(async () => success)));
    await expect(executor.integrate('a')).rejects.toThrow('成功凭证');
    await executor.execute();
    expect(fixture.tracker.get(1)!.run!.tasks.a.success?.noChange).toBe(true);
    expect(fixture.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
  });
  it.each(['before-rebase', 'after-rebase-before-save', 'after-merge-before-save'])('%s 中断后按凭证恢复，不重新调用 AI 或重复合并', async stage => {
    const fixture = graphFixture([task('a')]); directories.push(fixture.directory);
    let calls = 0;
    const ai = runner(async options => { calls++; fs.writeFileSync(path.join(options.workDir, 'a.txt'), '结果'); return success; });
    await expect(new TaskGraphExecutor(graphDeps(fixture, ai, { checkpoint: async name => { if (name === stage) throw new Error('模拟服务中断'); } })).execute()).rejects.toThrow('模拟服务中断');
    fixture.tracker = newTracker(fixture.data);
    fixture.tracker.transaction(1, record => { record.run!.dispatchId = 'recovered'; });
    await new TaskGraphExecutor(graphDeps(fixture, ai)).execute();
    expect(calls).toBe(1);
    expect(fixture.tracker.get(1)!.run!.tasks.a.status).toBe('merged');
    expect(git(fixture.integration, 'rev-list', '--count', 'main..HEAD')).toBe('1');
  });
});

it('同仓两个父 Issue 真正并行，暂停一个不取消另一个的任务或合并', async () => {
  const f = graphFixture([task('a')]); directories.push(f.directory);
  const integration2 = path.join(f.worktrees, 'issue-2');
  git(f.repo, 'worktree', 'add', '-b', 'iaf-2', integration2, 'main');
  const first = f.tracker.get(1)!;
  f.tracker.create({ lifecycle: { kind: 'running', phase: 'build' }, branchName: 'iaf-2', demandSpec: { ...first.demandSpec!, demandId: 'gh-2', sourceRef: { source: 'github-issue', externalId: '2', displayId: '2' } } });
  f.tracker.store.savePlan(2, { title: '第二个需求', description: '独立执行', acceptanceCriteria: ['通过'], tasks: [task('a')] }, f.tracker.get(2)!.run!.version);
  f.tracker.transaction(2, record => { record.run!.dispatchId = 'second'; record.run!.review!.decision = 'approved'; });
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const cancel = new AbortController();
  const ai = runner(async options => {
    started++; if (started === 2) release();
    await both;
    if (options.identity!.issueNumber === 1) {
      await new Promise<void>(resolve => { if (options.signal!.aborted) resolve(); else options.signal!.addEventListener('abort', () => resolve(), { once: true }); });
      return { ...success, success: false, errorMessage: '暂停' };
    }
    fs.writeFileSync(path.join(options.workDir, 'second.txt'), '第二个需求完成');
    return success;
  });
  const mutex = new AsyncMutex();
  const one = new TaskGraphExecutor(graphDeps(f, ai, { signal: cancel.signal, repositoryMutex: mutex })).execute();
  const stopped = expect(one).rejects.toThrow();
  const two = new TaskGraphExecutor(graphDeps(f, ai, { number: 2, integration: new GitOperations(integration2), repositoryMutex: mutex })).execute();
  await both;
  f.tracker.transaction(1, record => { record.run.stopIntent = { kind: 'pause', requestedAt: new Date().toISOString() }; record.lifecycle = { kind: 'paused', phase: 'build' }; });
  cancel.abort();
  await Promise.all([stopped, two]);
  expect(f.tracker.get(1)!.run!.tasks.a.success).toBeUndefined();
  expect(f.tracker.get(2)!.run!.tasks.a.status).toBe('merged');
  expect(fs.readFileSync(path.join(integration2, 'second.txt'), 'utf8')).toContain('完成');
});

it('冲突修复额度在失败、普通重试和重新加载后仍最多两次', async () => {
  const f = graphFixture([task('a'), task('b')]); directories.push(f.directory);
  let started = 0, conflictCalls = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const ai = runner(async options => {
    if (options.prompt.startsWith('只修复当前 rebase')) {
      expect(options).toMatchObject({ mode: 'agent', timeoutMs: 10000, idleTimeoutMs: 4567, timeoutGraceMs: 123, timeoutExtensionMs: 789, timeoutMaxExtensions: 2, model: 'test-model' });
      expect(options.prompt).toContain('批准计划');
      conflictCalls++;
      return { ...success, success: false, errorMessage: '冲突修复失败' };
    }
    started++; if (started === 2) release(); await both;
    fs.writeFileSync(path.join(options.workDir, 'README.md'), options.identity!.taskId);
    return success;
  });
  await expect(new TaskGraphExecutor(graphDeps(f, ai)).execute()).rejects.toThrow('冲突修复失败');
  const pending = Object.values(f.tracker.get(1)!.run!.tasks).find(t => t.status !== 'merged')!;
  expect(pending.conflictCallsUsed).toBe(1);
  for (const expected of [2, 2]) {
    f.tracker = newTracker(f.data);
    f.tracker.transaction(1, record => { record.run!.dispatchId = 'retry-' + expected; });
    await expect(new TaskGraphExecutor(graphDeps(f, ai)).execute()).rejects.toThrow();
    expect(f.tracker.get(1)!.run!.tasks[pending.taskId].conflictCallsUsed).toBe(expected);
  }
  expect(conflictCalls).toBe(2);
});
