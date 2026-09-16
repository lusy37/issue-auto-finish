import { describe, expect, it } from 'vitest';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import {
  collectPipelineArtifacts,
  getGatePhase,
  getRetryablePhases,
  projectLifecycleAction,
  projectLifecyclePhaseStatuses,
} from '../../src/pipeline/PipelineProjection.js';

describe('Pipeline 只读查询', () => {
  it('从阶段定义查询 gate、重做阶段和产物，不携带状态映射', () => {
    expect(getGatePhase(PLAN_MODE_PIPELINE)?.name).toBe('review');
    expect(getRetryablePhases(PLAN_MODE_PIPELINE)).toEqual(['plan', 'build', 'verify']);
    expect(collectPipelineArtifacts(PLAN_MODE_PIPELINE).map(file => file.filename)).toContain('01-plan.md');
    for (const phase of PLAN_MODE_PIPELINE.phases) {
      expect(phase).not.toHaveProperty('startState');
      expect(phase).not.toHaveProperty('doneState');
      expect(phase).not.toHaveProperty('approvedState');
    }
  });
});

describe('生命周期页面投影', () => {
  it.each([
    [{ kind: 'pending' }, { action: 'init', status: 'idle' }],
    [{ kind: 'ready' }, { action: 'init', status: 'ready' }],
    [{ kind: 'running', phase: 'build' }, { action: 'build', status: 'running' }],
    [{ kind: 'waiting', phase: 'review', planRevision: 1 }, { action: 'review', status: 'waiting' }],
    [{ kind: 'delivering' }, { action: 'delivery', status: 'ready' }],
    [{ kind: 'completed' }, { action: 'delivery', status: 'done' }],
  ] as const)('将 %j 单向投影为页面动作', (lifecycle, expected) => {
    expect(projectLifecycleAction(lifecycle)).toEqual(expected);
  });

  it('运行阶段只影响页面进度，不反向产生业务状态', () => {
    expect(projectLifecyclePhaseStatuses(
      PLAN_MODE_PIPELINE,
      { kind: 'running', phase: 'build' },
    )).toEqual({
      plan: 'completed',
      review: 'completed',
      build: 'in_progress',
      verify: 'pending',
    });
  });

  it('审核等待使用 gate_waiting，完成态将全部阶段显示为完成', () => {
    expect(projectLifecyclePhaseStatuses(
      PLAN_MODE_PIPELINE,
      { kind: 'waiting', phase: 'review', planRevision: 1 },
    ).review).toBe('gate_waiting');
    expect(Object.values(projectLifecyclePhaseStatuses(
      PLAN_MODE_PIPELINE,
      { kind: 'completed' },
    ))).toEqual(['completed', 'completed', 'completed', 'completed']);
  });
});
