import type { IssueLifecycle } from '../tracker/IssueLifecycle.js';
import type { PhaseStatus } from '../tracker/IssueRecord.js';
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
  /** 0 表示不限数量；正整数表示用户显式配置的图片上限。 */
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

/**
 * 工作台展示使用的任务状态，由当前 Issue 生命周期投影。
 */
export type UnifiedTaskStatus =
  | 'idle' // 尚未开始
  | 'preparing' // 准备中（创建分支、安装依赖等）
  | 'running' // 执行中
  | 'waiting' // 等待外部输入（审核等）
  | 'merging' // 合并中
  | 'completed' // 完成
  | 'failed'; // 失败

/**
 * IssueRecord 投影为工作台列表和详情使用的任务接口。
 */
export interface ExecutableTask {
  /** 任务类型标识 */
  readonly kind: 'issue';
  /** 唯一标识（string(issueIid)） */
  readonly taskId: string;
  /** 显示标题 */
  readonly title: string;
  /** 统一状态 */
  readonly status: UnifiedTaskStatus;
  /** 重试次数 */
  readonly attempts: number;
  /** 最后错误 */
  readonly lastError?: string;
  /** 创建时间 */
  readonly createdAt: string;
  /** 最后更新时间 */
  readonly updatedAt: string;
  /** 特性分支名 */
  readonly branchName?: string;
  /** 当前业务生命周期。 */
  readonly lifecycle: IssueLifecycle;
  /** 过滤分类：active/completed/failed/blocked/idle/skipped */
  readonly stateCategory?: string;
  /** 预计算的状态展示标签 */
  readonly displayLabel?: string;

  /** 阶段进度快照（由后端投影时预计算）。
   *  各阶段按定义顺序排列，包含真实事件时间戳。
   *  未提供时前端不渲染阶段进度列。 */
  readonly phaseProgress?: {
    name: string;
    label: string;
    status: PhaseStatus;
    startedAt?: string;
    completedAt?: string;
  }[];
}
