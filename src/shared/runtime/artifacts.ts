/** 前后端共用的纯产物元数据；只允许依赖 shared/runtime 内的浏览器可用模块。 */
export interface ArtifactSpec {
  readonly filename: string;
  readonly label: string;
  readonly editable: boolean;
}

export const ARTIFACTS = {
  plan: { filename: '01-plan.md', label: '实施计划', editable: false },
  verifyReport: { filename: '02-verify-report.md', label: '验证报告', editable: false },
  uatReport: { filename: '03-uat-report.md', label: '浏览器验收报告', editable: false },
  reviewFeedback: { filename: 'review-feedback.md', label: '审核反馈', editable: false },
  reviewHistory: { filename: 'review-history.json', label: '审核历史', editable: false },
  issueMeta: { filename: 'issue-meta.json', label: 'Issue 元信息', editable: false },
  uatRun: { filename: 'uat-run.json', label: '浏览器验收凭证', editable: false },
} as const satisfies Record<string, ArtifactSpec>;

/** 阶段产物用于展示和发布，内部凭证不作为阶段文档发布。 */
const PHASE_ARTIFACTS: Record<string, readonly ArtifactSpec[]> = {
  plan: [ARTIFACTS.plan],
  review: [ARTIFACTS.reviewFeedback, ARTIFACTS.reviewHistory],
  build: [],
  verify: [ARTIFACTS.verifyReport],
  uat: [ARTIFACTS.uatReport],
};

export function getPhaseArtifacts(phase: string): readonly ArtifactSpec[] {
  return Object.hasOwn(PHASE_ARTIFACTS, phase) ? PHASE_ARTIFACTS[phase] : [];
}
