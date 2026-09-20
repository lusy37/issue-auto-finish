import { IssueWorkflow } from '../../src/orchestrator/IssueWorkflow.js';
import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { reviewApi } from '../helpers/review-api.js';
import { newTracker } from '../helpers/dag-repository.js';
import { inspectWorkflow } from '../../src/orchestrator/inspectWorkflow.js';

it('双图读取真实审核检查点；重启、驳回、新轮次和修复入口不伪造状态或触发执行', async () => {
  const f = await reviewApi();
  try {
    const before = fs.readFileSync(f.tracker.store.file(42), 'utf8');
    const transaction = vi.spyOn(f.tracker, 'transaction');
    const { status, body } = await f.request('GET', '/api/issues/42/graphs');
    expect(status).toBe(200);
    expect(body.checkpoint.next).toContain('review');
    expect(body.checkpoint.tasks.some((task: { interrupts: unknown[] }) => task.interrupts.length)).toBe(true);
    expect(body.phaseIds).not.toContain('uat');
    expect(body.workflow.nodes.find((node: { id: string }) => node.id === 'uat').disabled).toBe(true);
    expect(body.workflow.edges).toContainEqual(expect.objectContaining({ source: 'verify', target: 'build' }));
    expect(body.topology.nodes.length).toBe(body.tasks.length);
    expect(transaction).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.tracker.store.file(42), 'utf8')).toBe(before);
    const reloaded = await inspectWorkflow(newTracker(f.data), 42);
    expect(reloaded.checkpoint).toEqual(body.checkpoint);
    await f.decide('reject-plan');
    expect((await inspectWorkflow(f.tracker, 42)).checkpoint.next).toContain('plan');
    await f.newPlan();
    const next = await inspectWorkflow(f.tracker, 42);
    expect(next.planRevision).toBeGreaterThan(body.planRevision);
    f.tracker.transaction(42, record => { record.run.buildEntry = 'repair-integration'; record.run.repairRounds = 1; record.lifecycle = { kind: 'paused', phase: 'build' }; });
    const repair = await inspectWorkflow(f.tracker, 42);
    expect(repair.buildEntry).toBe('repair-integration');
    expect(repair.lifecycle).toBe('paused');
    expect(repair.tasks).toEqual(next.tasks);
    f.tracker.resetFull(42);
    const restarted = await inspectWorkflow(f.tracker, 42);
    expect(restarted.threadId).not.toBe(body.threadId);
    expect(restarted.checkpoint.exists).toBe(false);
    expect(restarted.checkpoint.next).toEqual([]);
    expect(restarted.tasks).toEqual([]);
  } finally { await f.close(); }
});

it('读取过程中完整重做导致线程失效时重新取样', async () => {
  const f = await reviewApi();
  const original = IssueWorkflow.prototype.getState;
  const read = vi.spyOn(IssueWorkflow.prototype, 'getState').mockImplementationOnce(function (this: IssueWorkflow) {
    f.tracker.resetFull(42);
    return original.call(this);
  });
  try {
    const graph = await inspectWorkflow(f.tracker, 42);
    expect(graph.version).toBe(f.tracker.get(42)!.run.version);
    expect(graph.checkpoint.exists).toBe(false);
    expect(graph.tasks).toEqual([]);
  } finally { read.mockRestore(); await f.close(); }
});
