import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePipelineMode,
  getPipelineDef,
  createLifecycleManager,
  registerPipeline,
  getRegisteredModes,
  getAllPipelineDefs,
  _resetPipelineRegistry,
  PLAN_MODE_PIPELINE,
  buildPlanModePipeline,
} from '../../src/pipeline/PipelineDefinition.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { buildPipeline } from '../../src/orchestration/Pipeline.js';
import { PLAN_MODE_TRANSITIONS } from '../../src/orchestration/Transitions.js';

describe('PipelineDefinition', () => {
  beforeEach(() => {
    _resetPipelineRegistry();
  });

  afterEach(() => {
    _resetPipelineRegistry();
  });

  describe('resolvePipelineMode', () => {
    it('未指定模式时使用默认流水线', () => {
      expect(resolvePipelineMode()).toBe('plan-mode');
    });

    it('respects explicit plan-mode override', () => {
      expect(resolvePipelineMode('plan-mode')).toBe('plan-mode');
    });

    it('falls back to plan-mode when explicit value is not registered', () => {
      expect(resolvePipelineMode('unregistered')).toBe('plan-mode');
    });

    it('respects registered custom mode as explicit override', () => {
      registerPipeline({
        mode: 'custom',
        phases: [
          { name: 'test', label: 'Test', startState: IssueState.PhaseRunning,
            doneState: IssueState.Completed, kind: 'ai' },
        ],
      });
      expect(resolvePipelineMode('custom')).toBe('custom');
    });
  });

  describe('getPipelineDef', () => {
    it('returns plan-mode pipeline for plan-mode', () => {
      expect(getPipelineDef('plan-mode')).toBe(PLAN_MODE_PIPELINE);
    });

    it('throws for unregistered mode', () => {
      expect(() => getPipelineDef('nonexistent')).toThrow('Unknown pipeline mode: nonexistent');
    });
  });

  describe('registerPipeline', () => {
    it('registers a custom pipeline and retrieves it via getPipelineDef', () => {
      const customDef = {
        mode: 'custom-test',
        phases: [
          { name: 'my-phase', label: 'My Phase', startState: IssueState.PhaseRunning,
            doneState: IssueState.Completed, kind: 'ai' as const },
        ],
      };
      registerPipeline(customDef);
      expect(getPipelineDef('custom-test')).toBe(customDef);
    });

    it('overwrites existing registration', () => {
      const def1 = { mode: 'overwrite-test', phases: [] };
      const def2 = {
        mode: 'overwrite-test',
        phases: [
          { name: 'x', label: 'X', startState: IssueState.PhaseRunning,
            doneState: IssueState.Completed, kind: 'ai' as const },
        ],
      };
      registerPipeline(def1);
      registerPipeline(def2);
      expect(getPipelineDef('overwrite-test').phases).toHaveLength(1);
    });
  });

  describe('getRegisteredModes', () => {
    it('returns built-in modes by default', () => {
      const modes = getRegisteredModes();
      expect(modes).toContain('plan-mode');
    });

    it('includes custom modes after registration', () => {
      registerPipeline({ mode: 'extra', phases: [] });
      expect(getRegisteredModes()).toContain('extra');
    });
  });

  describe('getAllPipelineDefs', () => {
    it('returns all registered defs', () => {
      const defs = getAllPipelineDefs();
      expect(defs).toHaveLength(1);
      expect(defs.map(d => d.mode)).toEqual(['plan-mode']);
    });

    it('includes custom defs after registration', () => {
      registerPipeline({ mode: 'new-mode', phases: [] });
      expect(getAllPipelineDefs()).toHaveLength(2);
    });
  });

  describe('PLAN_MODE_PIPELINE', () => {
    it.each([false, true])('展示与执行阶段一致，且展示修改不污染执行定义：e2e=%s', (e2eEnabled) => {
      const view = buildPlanModePipeline({ e2eEnabled });
      const execution = buildPipeline({ e2e: e2eEnabled }, PLAN_MODE_TRANSITIONS);
      expect(view.phases.map(({ name, label, kind, artifacts, retryable, deploysPreview }) => ({
        id: name, label, kind, artifacts, retryable, deploysPreview,
      }))).toEqual(execution.phases.map(({ id, label, kind, artifacts, retryable, deploysPreview }) => ({
        id, label, kind, artifacts, retryable, deploysPreview,
      })));
      expect(view.phases.at(-1)?.doneState).toBe(IssueState.Completed);
      expect(view.phases.find(phase => phase.name === 'verify')?.doneState)
        .toBe(e2eEnabled ? IssueState.PhaseDone : IssueState.Completed);

      view.phases[0].artifacts![0].label = '局部展示修改';
      expect(execution.phases[0].artifacts![0].label).toBe('实施计划');
      expect(buildPlanModePipeline({ e2eEnabled }).phases[0].artifacts![0].label).toBe('实施计划');
    });

    it('has 4 phases with 1 gate', () => {
      expect(PLAN_MODE_PIPELINE.phases).toHaveLength(4);
      expect(PLAN_MODE_PIPELINE.phases.filter(p => p.kind === 'gate')).toHaveLength(1);
      expect(PLAN_MODE_PIPELINE.phases.filter(p => p.kind === 'ai')).toHaveLength(3);
    });

    it('has review gate with approvedState', () => {
      const gate = PLAN_MODE_PIPELINE.phases.find(p => p.kind === 'gate');
      expect(gate).toBeDefined();
      expect(gate!.name).toBe('review');
      expect(gate!.approvedState).toBe(IssueState.PhaseApproved);
    });

    it('has correct phase names', () => {
      expect(PLAN_MODE_PIPELINE.phases.map(p => p.name)).toEqual([
        'plan', 'review', 'build', 'verify',
      ]);
    });
  });

  describe('getPhasePreState', () => {
    it('returns BranchCreated for the first plan-mode phase', () => {
      expect(createLifecycleManager(PLAN_MODE_PIPELINE).getPhasePreState('plan')).toBe(IssueState.BranchCreated);
    });

    it('returns approvedState when previous phase is a gate', () => {
      expect(createLifecycleManager(PLAN_MODE_PIPELINE).getPhasePreState('build')).toBe(IssueState.PhaseApproved);
    });

    it('returns undefined for unknown phase name', () => {
      expect(createLifecycleManager(PLAN_MODE_PIPELINE).getPhasePreState('nonexistent')).toBeUndefined();
    });
  });

  describe('collectStateLabels', () => {
    it('includes Pending and Failed for plan-mode pipeline', () => {
      const labels = createLifecycleManager(PLAN_MODE_PIPELINE).collectStateLabels();
      expect(labels.get(IssueState.Pending)).toBe('待处理');
      expect(labels.get(IssueState.Failed)).toBe('失败');
      expect(labels.get(IssueState.Completed)).toBe('已完成');
    });

    it('generates labels from phase definitions', () => {
      const labels = createLifecycleManager(PLAN_MODE_PIPELINE).collectStateLabels();
      expect(labels.get('phase_running:plan')).toBe('规划中');
      expect(labels.get('phase_done:plan')).toBe('规划完成');
    });

    it('includes approvedState label for plan-mode', () => {
      const labels = createLifecycleManager(PLAN_MODE_PIPELINE).collectStateLabels();
      expect(labels.get('phase_approved:review')).toBe('审核通过');
    });
  });

  describe('derivePhaseStatuses', () => {
    it('marks current phase as in_progress', () => {
      const lm = createLifecycleManager(PLAN_MODE_PIPELINE);
      const statuses = lm.derivePhaseStatuses(IssueState.PhaseRunning, 'build');
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('completed');
      expect(statuses.build).toBe('in_progress');
      expect(statuses.verify).toBe('pending');
    });

    it('marks all phases as completed when state is Completed (last phase doneState)', () => {
      const statuses = createLifecycleManager(PLAN_MODE_PIPELINE).derivePhaseStatuses(IssueState.Completed);
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('completed');
      expect(statuses.build).toBe('completed');
      expect(statuses.verify).toBe('completed');
    });

    it('handles plan-mode gate phase', () => {
      const lm = createLifecycleManager(PLAN_MODE_PIPELINE);
      const statuses = lm.derivePhaseStatuses(IssueState.PhaseRunning, 'build');
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('completed');
      expect(statuses.build).toBe('in_progress');
      expect(statuses.verify).toBe('pending');
    });
  });
});
