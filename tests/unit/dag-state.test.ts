import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueRunStore } from '../../src/dag/IssueRunStore.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { validatePlan, type PlanContent, newIssueRun } from '../../src/dag/contracts.js';
import { writeJsonAtomicSync } from '../../src/utils/atomicFile.js';
import { ConcurrencyLimiter } from '../../src/ai-runner/ConcurrencyLimiter.js';
import { scopedRunner } from '../../src/dag/ScopedRunner.js';
import { createLifecycleManager, PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { eventBus } from '../../src/events/EventBus.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-state-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
const record = (number: number): IssueRecord => ({ state: IssueState.Pending, branchName: `iaf-${number}`, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), demandSpec: { demandId: `gh-${number}`, sourceRef: { source: 'github-issue', externalId: String(number), displayId: String(number) }, title: '需求', description: '实现并验收', createdAt: new Date().toISOString() }, run: newIssueRun() });
const content = (): PlanContent => ({ title: '计划', description: '共同完成父需求', acceptanceCriteria: ['验证通过'], tasks: [{ id: 'a', title: '接口', instructions: '实现接口', acceptanceCriteria: ['接口测试通过'], dependsOn: [] }, { id: 'b', title: '页面', instructions: '实现页面', acceptanceCriteria: ['页面可用'], dependsOn: ['a'] }] });
const tracker = () => new IssueTracker(directory, new Map([['plan-mode', createLifecycleManager(PLAN_MODE_PIPELINE)]]));

describe('聚合事务与不可变计划', () => {
  it('写入失败时磁盘、缓存与版本保持原值，后续调度被阻断', () => {
    let fail = false;
    const store = new IssueRunStore(directory, (file, value) => { if (fail) throw new Error('磁盘已满'); writeJsonAtomicSync(file, value); });
    store.insert(1, record(1));
    const previous = store.get(1)!;
    fail = true;
    expect(() => store.transaction(1, next => { next.state = IssueState.Completed; })).toThrow('磁盘已满');
    expect(store.get(1)).toEqual(previous);
    expect(new IssueRunStore(directory).get(1)).toEqual(previous);
    expect(store.isBlocked(1)).toBe(true);
    expect(() => store.transaction(1, next => { next.attempts++; })).toThrow('阻断');
  });
  it('并发完成任务及不同父 Issue 更新均不丢失；读返回独立快照', async () => {
    const store = new IssueRunStore(directory);
    store.insert(1, record(1)); store.insert(2, record(2));
    await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => store.transaction(i % 2 + 1, next => { next.attempts++; }))));
    expect(store.get(1)!.attempts).toBe(10); expect(store.get(2)!.attempts).toBe(10);
    const copy = store.get(1)!; copy.attempts = 999;
    expect(store.get(1)!.attempts).toBe(10);
  });
  it('计划版本不可覆盖，内容篡改及缺失引用在启动时被拒绝', () => {
    const store = new IssueRunStore(directory);
    store.insert(1, record(1));
    const first = store.savePlan(1, content(), store.get(1)!.run!.version);
    const second = store.savePlan(1, content(), store.get(1)!.run!.version);
    expect(second.revision).toBe(first.revision + 1);
    expect(store.readPlan(1, 1)).toEqual(first);
    fs.writeFileSync(store.planFile(1, 2), JSON.stringify({ ...second, title: '篡改' }));
    expect(() => new IssueRunStore(directory)).toThrow('摘要无效');
    fs.unlinkSync(store.planFile(1, 2));
    expect(() => new IssueRunStore(directory)).toThrow('原文件已保留');
  });
  it('旧格式只报告位置，不覆盖或迁移', () => {
    const file = path.join(directory, 'tracker.json');
    fs.writeFileSync(file, '{"format":"iaf-mini/v1"}');
    expect(() => new IssueRunStore(directory)).toThrow(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"format":"iaf-mini/v1"}');
  });
  it('父状态、历史和阶段进度在同一版本提交，磁盘故障不发送事件', () => {
    const tracked = tracker(); tracked.create(record(1));
    tracked.updateState(1, IssueState.PhaseRunning, { currentPhase: 'plan' });
    const version = tracked.get(1)!.run!.version;
    tracked.transaction(1, record => { record.state = IssueState.PhaseDone; record.phaseProgress = { plan: { status: 'completed' } }; record.phaseHistory = [{ phaseId: 'plan', attemptId: 1, startedAt: '2026-01-01T00:00:00Z', outcome: 'completed' }]; });
    const current = tracked.get(1)!;
    expect(current.run!.version).toBe(version + 1);
    expect(current.phaseHistory).toHaveLength(1);
    expect(current.phaseProgress?.plan.status).toBe('completed');
    const emitted = vi.spyOn(eventBus, 'emitTyped');
    vi.spyOn(tracked.store as never, 'persist' as never).mockImplementation(() => { throw new Error('磁盘故障'); });
    expect(() => tracked.transaction(1, next => { next.attempts++; })).toThrow('磁盘故障');
    expect(tracked.get(1)).toEqual(current);
    expect(emitted).not.toHaveBeenCalled();
  });
});

describe('任务图验证', () => {
  it('接受单任务及 A/B 完成后 C 的依赖图', () => {
    const plan = content(); plan.tasks[1].dependsOn = []; plan.tasks.push({ ...plan.tasks[0], id: 'c', dependsOn: ['a', 'b'] });
    expect(validatePlan(plan).tasks).toHaveLength(3);
    expect(validatePlan({ ...plan, tasks: [plan.tasks[0]] }).tasks).toHaveLength(1);
  });
  it.each(['重复', '循环', '缺失', '自依赖', '空图', '过多'])('拒绝%s', failure => {
    const plan = content();
    if (failure === '重复') plan.tasks[1].id = 'a';
    if (failure === '循环') plan.tasks[0].dependsOn = ['b'];
    if (failure === '缺失') plan.tasks[0].dependsOn = ['missing'];
    if (failure === '自依赖') plan.tasks[0].dependsOn = ['a'];
    if (failure === '空图') plan.tasks = [];
    if (failure === '过多') plan.tasks = Array.from({ length: 21 }, (_, i) => ({ ...plan.tasks[0], id: `t${i}` }));
    expect(() => validatePlan(plan)).toThrow();
  });
});

describe('取消与执行身份', () => {
  it('取消排队不占额度，释放不会重复计算', async () => {
    const limit = new ConcurrencyLimiter(1);
    const release = await limit.acquire();
    const cancel = new AbortController();
    const waiting = limit.acquire(cancel.signal);
    cancel.abort();
    await expect(waiting).rejects.toThrow('取消');
    expect(limit.waiting).toBe(0);
    release(); release();
    expect(limit.running).toBe(0);
  });
  it('普通重试的新调度使旧回调失效，仍记录旧调用退出', async () => {
    const tracked = tracker(); tracked.create(record(1));
    tracked.transaction(1, next => { next.run!.dispatchId = 'dispatch-1'; });
    let finish!: (value: { success: boolean; output: string; exitCode: number }) => void;
    const underlying = { run: () => new Promise<{ success: boolean; output: string; exitCode: number }>(resolve => { finish = resolve; }), killAll() {}, killByWorkDir() { return 0; } };
    const call = scopedRunner(underlying, tracked, 1, new AbortController().signal).run({ prompt: '实现', workDir: directory, timeoutMs: 1000 });
    tracked.transaction(1, next => { next.run!.dispatchId = 'dispatch-2'; });
    finish({ success: true, output: '旧结果', exitCode: 0 });
    await expect(call).rejects.toThrow('身份已失效');
    expect(Object.values(tracked.get(1)!.run!.calls)[0].status).toBe('exited');
  });
});

it('同一阶段发起新调用后，旧调用结果也不能被采用', async () => {
  const tracked = tracker(); tracked.create(record(1));
  tracked.transaction(1, next => { next.currentPhase = 'plan'; next.run!.dispatchId = 'dispatch'; });
  let finish!: (value: { success: boolean; output: string; exitCode: number }) => void;
  const underlying = { run: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ success: true, output: '新结果', exitCode: 0 }), killAll() {}, killByWorkDir() { return 0; } };
  const scoped = scopedRunner(underlying, tracked, 1, new AbortController().signal, '$phase:plan');
  const old = scoped.run({ prompt: '旧调用', workDir: directory, timeoutMs: 1000 });
  const latest = await scoped.run({ prompt: '新调用', workDir: directory, timeoutMs: 1000 });
  finish({ success: true, output: '旧结果', exitCode: 0 });
  await expect(old).rejects.toThrow('新的执行替代');
  expect(latest.output).toBe('新结果');
});
