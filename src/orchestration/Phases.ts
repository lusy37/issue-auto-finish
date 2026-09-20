import type { PhaseId } from './WorkflowState.js';
import { getPhaseArtifacts, type ArtifactSpec } from '../shared/runtime/artifacts.js';
export type { ArtifactSpec } from '../shared/runtime/artifacts.js';

/** 阶段元信息，与运行状态分开定义 */
export interface PhaseSpec {
  readonly id: PhaseId;
  readonly label: string;
  /** 'ai' 表示需调用 AI Runner；'gate' 表示直接进入 gate-waiting */
  readonly kind: 'ai' | 'gate';
  /** 该阶段产出的产物文件 */
  readonly artifacts?: readonly ArtifactSpec[];
  /** 是否可被用户单独重试。默认：kind === 'ai' */
  readonly retryable?: boolean;
  /** 此阶段完成后是否启动预览服务器 */
  readonly deploysPreview?: boolean;
}

const PHASE_PLAN: PhaseSpec = {
  id: 'plan',
  label: '规划',
  kind: 'ai',
  artifacts: getPhaseArtifacts('plan'),
};

const PHASE_REVIEW: PhaseSpec = {
  id: 'review',
  label: '审核',
  kind: 'gate',
  retryable: false,
  artifacts: getPhaseArtifacts('review'),
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
  artifacts: getPhaseArtifacts('verify'),
};

const PHASE_UAT: PhaseSpec = {
  id: 'uat',
  label: 'UAT验证',
  kind: 'ai',
  retryable: true,
  artifacts: getPhaseArtifacts('uat'),
};

/** 图节点与展示层共用阶段元信息；实际路由在 IssueWorkflow 中定义。 */
export function getPlanModePhases(e2eEnabled: boolean): readonly PhaseSpec[] {
  const phases = [PHASE_PLAN, PHASE_REVIEW, PHASE_BUILD, PHASE_VERIFY];
  if (e2eEnabled) phases.push(PHASE_UAT);
  return Object.freeze(phases);
}
