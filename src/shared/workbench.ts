import type { UAT_FORMAT, VISUAL_CASES_FORMAT } from './runtime/formats.js';
export type { IssueRun, ExecutionIdentity, TaskDefinition, TaskRun } from '../dag/contracts.js';
/** 前后端共用的数据契约；仅包含类型，浏览器不会加载服务端执行逻辑。 */
export type { IssueLifecycle } from '../tracker/IssueLifecycle.js';
export type { IssueRecord, PhaseProgress, PhaseStatus } from '../tracker/IssueRecord.js';
export type { PhaseHistoryEntry } from '../orchestration/PhaseHistory.js';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ScreenshotEvidence {
  id: string;
  path: string;
  sha256: string;
  testId: string;
  projectName: string;
  caseId: string;
  sceneId: string;
  viewport: ViewportSize;
  pageUrl: string;
  acceptanceRefs: string[];
}

export type UatRunStatus = 'running' | 'completed' | 'cancelled' | 'interrupted';
export type VisualReviewStatus = 'not-run' | 'pending' | 'passed' | 'failed' | 'needs-review';

export interface VisualReviewIssue {
  screenshotId: string;
  caseId: string;
  sceneId: string;
  viewport: ViewportSize;
  severity: 'blocker' | 'major' | 'minor';
  screenshot: string;
  description: string;
  expected: string;
  observed: string;
}

export type VisualCoverageGapKind =
  | 'missing-case'
  | 'missing-viewport'
  | 'missing-visible-state'
  | 'unreadable-image'
  | 'incomplete-agent-output';

/** 服务端生成的视觉证据缺口；gapIndex 只在 sourceRunId 内有效。 */
export interface VisualCoverageGap {
  gapIndex?: number;
  sourceRunId?: string;
  description: string;
  kind: VisualCoverageGapKind;
  acceptanceRefs: string[];
  caseId?: string;
  sceneId?: string;
  viewport?: ViewportSize;
  screenshotIds: string[];
}

export interface VisualTestRef {
  path: string;
  line: number;
  testId: string;
  acceptanceRefs: string[];
  reportDigest: string;
}

export type VisualRepairDecisionKind =
  | 'behavior-covered'
  | 'add-visual-evidence'
  | 'fix-ui'
  | 'retry-visual';

export interface VisualRepairDecision {
  schemaVersion: 'iaf-mini/visual-repair/v1';
  decision: VisualRepairDecisionKind;
  sourceRunId: string;
  candidateCommit: string;
  planRevision: number;
  planDigest: string;
  buildGeneration: number;
  gapIndex: number;
  reason: string;
  testRefs: VisualTestRef[];
  changedFiles: string[];
}

export interface VisualRepairContext {
  sourceRunId: string;
  candidateCommit: string;
  planRevision: number;
  planDigest: string;
  buildGeneration: number;
  gap: VisualCoverageGap;
  report: string;
}

export interface VisualReviewResult {
  status: VisualReviewStatus;
  summary: string;
  issues: VisualReviewIssue[];
  selectedScreenshots: string[];
  checkedScreenshots: string[];
  unreviewedScreenshots: string[];
  /** 展示用文本，结构化缺口使用 coverageGapDetails。 */
  coverageGaps: string[];
  coverageGapDetails?: VisualCoverageGap[];
  reviewRound?: number;
  maxReviewRounds?: number;
  reasonCode?: string;
  requestedModel?: string;
  actualModel?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface UatPolicySnapshot {
  visualReviewEnabled: boolean;
  maxImages: number;
  maxReviewRounds?: number;
  model?: string;
  timeoutMs: number;
}

export interface UatExecution {
  candidateCommit: string;
  planRevision: number;
  planDigest: string;
  buildGeneration: number;
  dispatchId: string;
  phaseAttemptNo: number;
  visualCallId?: string;
}

export interface MachineUatResult {
  passed: boolean;
  playwrightExitCode: number | null;
  machineCancelled: boolean;
  reportValid: boolean;
  reportErrors: string[];
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  screenshots: ScreenshotEvidence[];
  reportAvailable: boolean;
  failureKind?: 'assertion' | 'environment';
  error?: string;
  startedAt: string;
  machineFinishedAt: string;
}

export interface VisualCase {
  id: string;
  sceneId: string;
  acceptanceRefs: string[];
  viewports: ViewportSize[];
  expectedState: string;
}

export interface VisualCasesManifest {
  format: typeof VISUAL_CASES_FORMAT;
  planDigest: string;
  cases: VisualCase[];
}

export interface UatResult {
  format: typeof UAT_FORMAT;
  status: UatRunStatus;
  runId: string;
  issueIid: number;
  machinePassed: boolean;
  passed: boolean;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  evidence: ScreenshotEvidence[];
  reportAvailable: boolean;
  startedAt: string;
  machineFinishedAt?: string;
  finishedAt?: string;
  visualReview: VisualReviewResult;
  policy: UatPolicySnapshot;
  execution: UatExecution;
  summaryDigest?: string;
  failureKind?: 'assertion' | 'environment';
  error?: string;
}

export interface TaskSummary {
  range: '7d' | '30d' | 'all';
  total: number;
  completed: number;
  failed: number;
  successRate: number | null;
  totalDurationMs: number;
  averageDurationMs: number | null;
  retries: number;
  interventions: number;
  phases: Record<string, { runs: number; durationMs: number; failures: number }>;
  uat: { passed: number; failed: number; passRate: number | null };
}
