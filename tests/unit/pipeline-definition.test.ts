import { describe, expect, it } from 'vitest';
import {
  PLAN_MODE_PIPELINE,
  buildPlanModePipeline,
} from '../../src/pipeline/PipelineMetadata.js';
import { getPlanModePhases } from '../../src/orchestration/Phases.js';
import { projectLifecyclePhaseStatuses } from '../../src/pipeline/PipelineProjection.js';

describe('plan-mode 流水线', () => {
  it.each([false, true])('展示与执行阶段一致，且展示修改不污染执行定义：e2e=%s', (e2eEnabled) => {
    const view = buildPlanModePipeline({ e2eEnabled });
    const execution = getPlanModePhases(e2eEnabled);
    expect(view.phases.map(({ name, label, kind, artifacts, retryable }) => ({
      id: name, label, kind, artifacts, retryable,
    }))).toEqual(execution.map(({ id, label, kind, artifacts, retryable }) => ({
      id, label, kind, artifacts, retryable,
    })));
    view.phases[0].artifacts![0].label = '局部展示修改';
    expect(execution[0].artifacts![0].label).toBe('实施计划');
    expect(buildPlanModePipeline({ e2eEnabled }).phases[0].artifacts![0].label).toBe('实施计划');
  });

  it('默认流水线包含计划、审核、构建和验证', () => {
    expect(PLAN_MODE_PIPELINE.phases.map((phase) => phase.name)).toEqual([
      'plan', 'review', 'build', 'verify',
    ]);
    expect(PLAN_MODE_PIPELINE.phases.filter((phase) => phase.kind === 'gate')).toHaveLength(1);
  });

  it('启用 E2E 时追加 UAT', () => {
    expect(buildPlanModePipeline({ e2eEnabled: true }).phases.map((phase) => phase.name)).toEqual([
      'plan', 'review', 'build', 'verify', 'uat',
    ]);
  });

  it('按生命周期投影阶段状态', () => {
    expect(projectLifecyclePhaseStatuses(PLAN_MODE_PIPELINE, {
      kind: 'running', phase: 'build',
    })).toMatchObject({
      plan: 'completed', review: 'completed', build: 'in_progress', verify: 'pending',
    });
    expect(projectLifecyclePhaseStatuses(PLAN_MODE_PIPELINE, {
      kind: 'waiting', phase: 'review', planRevision: 1,
    })).toMatchObject({ review: 'gate_waiting', build: 'pending' });
  });
});
