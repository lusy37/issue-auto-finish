import type { PhaseIntent } from './Intent.js';

/**
 * 流水线定义（Pipeline）— 纯数据。
 *
 * 关键设计：
 * - 阶段描述与运行状态分离，状态由 OrchestrationState 和 Reducer 计算。
 * - transitions 显式声明阶段转换和验证失败后的有限修复规则。
 * - 每个 Orchestrator 实例持有自己的 Pipeline 副本，无全局 registry 副作用。
 */
export interface Pipeline {
  readonly id: string;
  readonly profile: PipelineProfile;
  readonly phases: readonly PhaseSpec[];
  readonly transitions: readonly TransitionRule[];
}

/** 流水线配置组合 — 决定哪些阶段被注入 */
export interface PipelineProfile {
  readonly e2e: boolean;
}

/** 阶段元信息，与运行状态分开定义 */
export interface PhaseSpec {
  readonly id: string;
  readonly label: string;
  /** 'ai' 表示需调用 AI Runner；'gate' 表示直接进入 gate-waiting */
  readonly kind: 'ai' | 'gate';
  /** 该阶段产出的产物文件 */
  readonly artifacts?: readonly ArtifactSpec[];
  /** 是否可被用户单独重试。默认：kind === 'ai' */
  readonly retryable?: boolean;
  /** 此阶段完成后是否启动预览服务器 */
  readonly deploysPreview?: boolean;
  /** 该阶段是否声明可能产出 awaitGate Intent（用于前端预测 gate 出现位置） */
  readonly mayAwaitGate?: boolean;
  /**
   * gate 通过后是否**重跑当前阶段**而非前进到下一阶段。
   *
   * 典型用法：两段式 AI 阶段（如 release detect→exec、uat plan→run）。
   * 第一次 run 产出检测/计划并 awaitGate，user approve 后再 run 一次执行真正动作。
   *
   * 默认 false：approve 后正常 advance 到下一阶段（review gate 的行为）。
   */
  readonly rerunOnApprove?: boolean;
}

/** 产物文件元信息 */
export interface ArtifactSpec {
  readonly filename: string;
  readonly label: string;
  readonly editable: boolean;
}

/**
 * 编排转移规则 — 声明式表达「阶段返回某种 Intent 时编排器该做什么」。
 *
 * 评估顺序：从前到后线性扫描，第一个匹配的规则生效。
 */
export interface TransitionRule {
  /** 来源阶段 ID，或 `*` 通配所有阶段 */
  readonly from: string | '*';
  /** 触发该规则的 Intent kind */
  readonly on: 'completed' | 'failed' | 'requestRetryFrom' | 'awaitGate' | 'awaitAsync';
  /** 额外的 Intent 内容匹配（如错误类型、目标阶段名） */
  readonly match?: (intent: PhaseIntent) => boolean;
  /** 触发的动作 */
  readonly action: TransitionAction;
}

/** 转移动作 */
export type TransitionAction =
  | { readonly kind: 'advance' }
  | { readonly kind: 'retry-same-phase'; readonly maxAttempts: number }
  | {
      readonly kind: 'retry-from';
      readonly targetPhaseId: string;
      /** 同一 retry-from 链路允许的最大轮次（如 verify-fix 默认 3） */
      readonly maxIterations: number;
      /** 是否重置 attempts 计数 */
      readonly resetAttempts: boolean;
    }
  | { readonly kind: 'suspend' }
  | { readonly kind: 'fail-pipeline'; readonly retryable: 'auto' | 'manual' }
  | { readonly kind: 'await-async' };

// ---------------------------------------------------------------------------
// 内置阶段定义
// ---------------------------------------------------------------------------

const PHASE_PLAN: PhaseSpec = {
  id: 'plan',
  label: '规划',
  kind: 'ai',
  artifacts: [{ filename: '01-plan.md', label: '实施计划', editable: true }],
};

const PHASE_REVIEW: PhaseSpec = {
  id: 'review',
  label: '审核',
  kind: 'gate',
  retryable: false,
  mayAwaitGate: true,
  artifacts: [
    { filename: 'review-feedback.md', label: '审核反馈', editable: false },
    { filename: 'review-history.json', label: '审核历史', editable: false },
  ],
};

const PHASE_BUILD: PhaseSpec = {
  id: 'build',
  label: '实施',
  kind: 'ai',
  deploysPreview: true,
};

const PHASE_VERIFY: PhaseSpec = {
  id: 'verify',
  label: '验证',
  kind: 'ai',
  artifacts: [{ filename: '02-verify-report.md', label: '验证报告', editable: false }],
};

const PHASE_UAT: PhaseSpec = {
  id: 'uat',
  label: 'UAT验证',
  kind: 'ai',
  retryable: true,
  artifacts: [{ filename: '03-uat-report.md', label: 'UAT报告', editable: false }],
};

/** 状态机与展示层共用阶段元信息，展示层自行适配任务状态字段。 */
export function getPlanModePhases(e2eEnabled: boolean): readonly PhaseSpec[] {
  const phases = [PHASE_PLAN, PHASE_REVIEW, PHASE_BUILD, PHASE_VERIFY];
  if (e2eEnabled) phases.push(PHASE_UAT);
  return Object.freeze(phases);
}

// ---------------------------------------------------------------------------
// Pipeline 构造器
// ---------------------------------------------------------------------------

/**
 * 根据 profile 构建 Pipeline。
 *
 * 关键不变量：
 * - 同一 profile 多次调用返回的 phases 引用相等（结构共享 + 不同顺序无副作用）。
 * - 启用 e2e 不会修改 verify 等其他阶段的字段定义。
 */
export function buildPipeline(profile: PipelineProfile, transitions: readonly TransitionRule[]): Pipeline {
  return Object.freeze({
    id: 'plan-mode',
    profile: Object.freeze({ ...profile }),
    phases: getPlanModePhases(profile.e2e),
    transitions: Object.freeze([...transitions]),
  });
}

/** 获取阶段索引；未找到返回 -1 */
export function findPhaseIndex(pipeline: Pipeline, phaseId: string): number {
  return pipeline.phases.findIndex((p) => p.id === phaseId);
}

/** 获取阶段定义；未找到返回 undefined */
export function findPhaseSpec(pipeline: Pipeline, phaseId: string): PhaseSpec | undefined {
  return pipeline.phases.find((p) => p.id === phaseId);
}

/** 是否是流水线最后一个阶段 */
export function isLastPhase(pipeline: Pipeline, phaseId: string): boolean {
  const idx = findPhaseIndex(pipeline, phaseId);
  return idx >= 0 && idx === pipeline.phases.length - 1;
}

/** 获取下一阶段 ID；如果是最后一个返回 undefined */
export function nextPhaseId(pipeline: Pipeline, phaseId: string): string | undefined {
  const idx = findPhaseIndex(pipeline, phaseId);
  if (idx < 0 || idx === pipeline.phases.length - 1) return undefined;
  return pipeline.phases[idx + 1].id;
}

/** 第一个阶段 ID（流水线非空时存在） */
export function firstPhaseId(pipeline: Pipeline): string {
  return pipeline.phases[0].id;
}
