import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePipelineMode,
  getPipelineDef,
  registerPipeline,
  getRegisteredModes,
  getAllPipelineDefs,
  _resetPipelineRegistry,
  PLAN_MODE_PIPELINE,
  buildPlanModePipeline,
} from '../../src/pipeline/PipelineMetadata.js';
import { getPlanModePhases } from '../../src/orchestration/Phases.js';
import { projectLifecyclePhaseStatuses } from '../../src/pipeline/PipelineProjection.js';

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
          { name: 'test', label: 'Test', kind: 'ai' },
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
          { name: 'my-phase', label: 'My Phase', kind: 'ai' as const },
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
          { name: 'x', label: 'X', kind: 'ai' as const },
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
      const execution = { phases: getPlanModePhases(e2eEnabled) };
      expect(view.phases.map(({ name, label, kind, artifacts, retryable, deploysPreview }) => ({
        id: name, label, kind, artifacts, retryable, deploysPreview,
      }))).toEqual(execution.phases.map(({ id, label, kind, artifacts, retryable, deploysPreview }) => ({
        id, label, kind, artifacts, retryable, deploysPreview,
      })));
      view.phases[0].artifacts![0].label = '局部展示修改';
      expect(execution.phases[0].artifacts![0].label).toBe('实施计划');
      expect(buildPlanModePipeline({ e2eEnabled }).phases[0].artifacts![0].label).toBe('实施计划');
    });

    it('has 4 phases with 1 gate', () => {
      expect(PLAN_MODE_PIPELINE.phases).toHaveLength(4);
      expect(PLAN_MODE_PIPELINE.phases.filter(p => p.kind === 'gate')).toHaveLength(1);
      expect(PLAN_MODE_PIPELINE.phases.filter(p => p.kind === 'ai')).toHaveLength(3);
    });

    it('has review gate without a second state mapping', () => {
      const gate = PLAN_MODE_PIPELINE.phases.find(p => p.kind === 'gate');
      expect(gate).toBeDefined();
      expect(gate!.name).toBe('review');
      expect(gate).not.toHaveProperty('approvedState');
      expect(gate).not.toHaveProperty('startState');
      expect(gate).not.toHaveProperty('doneState');
    });

    it('has correct phase names', () => {
      expect(PLAN_MODE_PIPELINE.phases.map(p => p.name)).toEqual([
        'plan', 'review', 'build', 'verify',
      ]);
    });
  });

  describe('projectLifecyclePhaseStatuses', () => {
    it('将当前执行阶段标记为进行中', () => {
      const statuses = projectLifecyclePhaseStatuses(PLAN_MODE_PIPELINE, { kind: 'running', phase: 'build' });
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('completed');
      expect(statuses.build).toBe('in_progress');
      expect(statuses.verify).toBe('pending');
    });

    it('任务完成时所有阶段均为完成', () => {
      const statuses = projectLifecyclePhaseStatuses(PLAN_MODE_PIPELINE, { kind: 'completed' });
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('completed');
      expect(statuses.build).toBe('completed');
      expect(statuses.verify).toBe('completed');
    });

    it('审核 gate 使用等待状态', () => {
      const statuses = projectLifecyclePhaseStatuses(PLAN_MODE_PIPELINE, { kind: 'waiting', phase: 'review' });
      expect(statuses.plan).toBe('completed');
      expect(statuses.review).toBe('gate_waiting');
      expect(statuses.build).toBe('pending');
      expect(statuses.verify).toBe('pending');
    });
  });
});
