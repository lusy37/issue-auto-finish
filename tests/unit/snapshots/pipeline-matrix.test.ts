import { describe, it, expect } from 'vitest';
import {
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
  type Pipeline,
  type PhaseSpec,
} from '../../../src/orchestration/index.js';

/**
 * Pipeline 配置矩阵快照（MAT-1~6 + INV-5/6）
 *
 * 关键不变量：
 * - 2 种 (release, e2e) 组合都有快照保护
 * - 启用 e2e 不修改其他阶段的字段（INV-5）
 * - PhaseSpec JSON 序列化不含任何 IssueState 字符串（INV-6）
 */

function summarize(pipeline: Pipeline) {
  return {
    id: pipeline.id,
    profile: pipeline.profile,
    phases: pipeline.phases.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      retryable: p.retryable,
      deploysPreview: p.deploysPreview,
      mayAwaitGate: p.mayAwaitGate,
      artifacts: p.artifacts,
    })),
  };
}

describe('Pipeline matrix snapshots (MAT-1~6)', () => {
  it('MAT-1: (release=false, e2e=false) → 4 阶段', () => {
    const pipeline = buildPipeline({ e2e: false }, PLAN_MODE_TRANSITIONS);
    expect(pipeline.phases.map((p) => p.id)).toEqual(['plan', 'review', 'build', 'verify']);
    expect(summarize(pipeline)).toMatchSnapshot();
  });

  it('MAT-3: (release=false, e2e=true) → 5 阶段（含 uat）', () => {
    const pipeline = buildPipeline({ e2e: true }, PLAN_MODE_TRANSITIONS);
    expect(pipeline.phases.map((p) => p.id)).toEqual([
      'plan', 'review', 'build', 'verify', 'uat',
    ]);
    expect(summarize(pipeline)).toMatchSnapshot();
  });

  it('MAT-5: 2 种组合的 transitions 快照（确认不变）', () => {
    expect(PLAN_MODE_TRANSITIONS.map((t) => ({
      from: t.from,
      on: t.on,
      action: t.action,
    }))).toMatchSnapshot();
  });
});

describe('INV-5: 启用 e2e 不修改其他阶段定义', () => {
  function findPhase(pipeline: Pipeline, id: string): PhaseSpec | undefined {
    return pipeline.phases.find((p) => p.id === id);
  }

  it('verify 阶段在所有 2 种组合下定义完全一致', () => {
    const profiles = [
      { e2e: false },
      { e2e: false },
      { e2e: true },
      { e2e: true },
    ];
    const verifySpecs = profiles.map((p) =>
      findPhase(buildPipeline(p, PLAN_MODE_TRANSITIONS), 'verify'),
    );
    expect(verifySpecs.every((s) => s !== undefined)).toBe(true);
    // 用 JSON 字符串比较结构相等（不要求引用相等，只要内容一致）
    const serialized = verifySpecs.map((s) => JSON.stringify(s));
    expect(new Set(serialized).size).toBe(1);
  });

  it('plan / review / build 阶段在所有 2 种组合下定义完全一致', () => {
    const profiles = [
      { e2e: false },
      { e2e: false },
      { e2e: true },
      { e2e: true },
    ];
    for (const phaseId of ['plan', 'review', 'build']) {
      const specs = profiles.map((p) =>
        findPhase(buildPipeline(p, PLAN_MODE_TRANSITIONS), phaseId),
      );
      const serialized = specs.map((s) => JSON.stringify(s));
      expect(new Set(serialized).size, `Phase ${phaseId} differs across profiles`).toBe(1);
    }
  });
});

describe('INV-6: PhaseSpec 序列化不含 IssueState', () => {
  it('所有阶段的 JSON 序列化不含 phase_running / phase_done / completed / phase_waiting 等状态字符串', () => {
    const pipeline = buildPipeline({ e2e: true }, PLAN_MODE_TRANSITIONS);
    const json = JSON.stringify(pipeline);
    const FORBIDDEN = [
      '"phase_running"',
      '"phase_done"',
      '"phase_waiting"',
      '"phase_approved"',
      '"branch_created"',
      '"resolving_conflict"',
      '"deployed"',
    ];
    for (const forbidden of FORBIDDEN) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('INV-4: Pipeline 不写全局 registry', () => {
  it('多次 buildPipeline 互不影响', () => {
    const p1 = buildPipeline({ e2e: true }, PLAN_MODE_TRANSITIONS);
    const p2 = buildPipeline({ e2e: false }, PLAN_MODE_TRANSITIONS);
    // p1 含 release，p2 不含 — 互不污染
    expect(p1.phases.map((p) => p.id)).toContain('uat');
    expect(p2.phases.map((p) => p.id)).not.toContain('uat');
  });

  it('Pipeline 是 frozen，外部不可改', () => {
    const p = buildPipeline({ e2e: true }, PLAN_MODE_TRANSITIONS);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.profile)).toBe(true);
    expect(Object.isFrozen(p.phases)).toBe(true);
    expect(Object.isFrozen(p.transitions)).toBe(true);
  });
});
