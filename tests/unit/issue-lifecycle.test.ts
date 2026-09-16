import { describe, expect, it } from 'vitest';
import {
  InvalidLifecycleTransitionError,
  reduceIssueLifecycle,
  type IssueLifecycle,
} from '../../src/tracker/IssueLifecycle.js';

describe('IssueLifecycle', () => {
  it('将三个旧 ready 类状态统一为 ready 语义', () => {
    expect(reduceIssueLifecycle({ kind: 'pending' }, { type: 'setup-completed' })).toEqual({ kind: 'ready' });
    expect(reduceIssueLifecycle({ kind: 'running', phase: 'build' }, { type: 'phase-completed', phase: 'build' })).toEqual({ kind: 'ready' });
    expect(reduceIssueLifecycle({ kind: 'waiting', phase: 'review', planRevision: 2 }, { type: 'gate-resolved', phase: 'review', action: 'approve', planRevision: 2 })).toEqual({ kind: 'ready' });
  });

  it('waiting 支持非 review gate 且不要求计划版本', () => {
    expect(reduceIssueLifecycle(
      { kind: 'running', phase: 'uat' },
      { type: 'gate-interrupted', phase: 'uat' },
    )).toEqual({ kind: 'waiting', phase: 'uat', planRevision: undefined });
  });

  it('拒绝审核计划版本不匹配', () => {
    expect(() => reduceIssueLifecycle(
      { kind: 'waiting', phase: 'review', planRevision: 1 },
      { type: 'gate-resolved', phase: 'review', action: 'approve', planRevision: 2 },
    )).toThrow('审核计划版本或等待状态已改变');
  });

  it.each<[{ current: IssueLifecycle; event: Parameters<typeof reduceIssueLifecycle>[1] }]>([
    [{ current: { kind: 'completed' }, event: { type: 'phase-started', phase: 'build' } }],
    [{ current: { kind: 'cancelled' }, event: { type: 'continue-requested' } }],
    [{ current: { kind: 'paused', phase: 'build' }, event: { type: 'phase-completed', phase: 'build' } }],
  ])('拒绝非法转换 %#', ({ current, event }) => {
    expect(() => reduceIssueLifecycle(current, event)).toThrow(InvalidLifecycleTransitionError);
  });

  it('完成态只有显式冲突修复可以返回 ready', () => {
    expect(reduceIssueLifecycle({ kind: 'completed' }, { type: 'conflict-repair-started' })).toEqual({ kind: 'ready' });
  });
});
