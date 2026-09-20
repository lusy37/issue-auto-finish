import type { GitHubIssue, GitHubClient } from '../clients/GitHubClient.js';
import type { WorktreeContext } from '../git/WorktreeContext.js';
import type { IssueRecord } from '../tracker/IssueRecord.js';
import type { PhaseContext } from '../phases/BasePhase.js';
import type { PipelineDef } from '../pipeline/PipelineMetadata.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { Config } from '../config.js';
import type { GitOperations } from '../git/GitOperations.js';
import type { AIRunner } from '../ai-runner/index.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import type { SupplementStore } from '../supplement/SupplementStore.js';
import type { AsyncMutex } from '../utils/AsyncMutex.js';
import type { PortAllocator } from '../preview/PortAllocator.js';
import type { DevServerManager } from '../preview/DevServerManager.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { EventBus } from '../events/EventBus.js';
import type { WorkspaceManager } from '../workspace/index.js';

/**
 * 共享上下文 DTO — 在各步骤之间传递的 Issue 处理状态。
 */
export interface IssueProcessingContext {
  issue: GitHubIssue;
  branchName: string;
  wtCtx: WorktreeContext;
  record: IssueRecord;
  isRetry: boolean;
  pipelineDef: PipelineDef;
  demand: DemandSpec;
  phaseCtx: PhaseContext;
}

/**
 * SetupStep 的产出 — 在 worktree 中创建的对象。
 */
export interface SetupResult {
  /** primary repo 的 GitOperations */
  wtGit: GitOperations;
  wtPlan: PlanPersistence;
}

/**
 * RunWorkflowStep 的产出 — 记录预览服务器是否启动。
 */
export interface WorkflowRunResult {
  serversStarted: boolean;
}

// ── OrchestratorDeps 域分组子接口 ──

/** 核心依赖 — 所有 Step 共用 */
export interface CoreDeps {
  signal?: AbortSignal;
  config: Config;
  tracker: IssueTracker;
  github: GitHubClient;
  eventBus: EventBus;
  emitProgress(issueIid: number, step: string, message: string): void;
}

/** Git 操作依赖 — Setup / Delivery */
export interface GitDeps {
  mainGit: GitOperations;
  mainGitMutex: AsyncMutex;
  ensureWorktree(wtCtx: WorktreeContext): Promise<void>;
  workspaceManager: WorkspaceManager;
}

/** AI 执行依赖 — Workflow */
export interface AIDeps {
  aiRunner: AIRunner;
}

/** 预览服务器依赖 — Workflow / Delivery / Failure */
export interface PreviewDeps {
  startPreviewServers(wtCtx: WorktreeContext, issue: GitHubIssue): Promise<import('../preview/PortAllocator.js').PortPair | null>;
  stopPreviewServers(issueIid: number): Promise<void>;
  buildPreviewUrl(issueIid: number): string | null;
  getPortsForIssue(issueIid: number): import('../preview/PortAllocator.js').PortPair | undefined;
  isPreviewRunning(issueIid: number): boolean;
}

/** 策略/安装依赖 — Setup / Workflow */
export interface PolicyDeps {
  shouldAutoApprove(issueLabels: string[]): boolean;
  installDependencies(workDir: string, signal?: AbortSignal, force?: boolean): Promise<void>;
  supplementStore?: SupplementStore;
}

/**
 * OrchestratorDeps — 编排器注入给各步骤的依赖包。
 *
 * 由 IssueService 一次性构建，步骤函数按需取用。
 * 按域拆分为 CoreDeps / GitDeps / AIDeps / PreviewDeps / PolicyDeps。
 */
export interface OrchestratorDeps
  extends CoreDeps, GitDeps, AIDeps, PreviewDeps, PolicyDeps {
  portAllocator: PortAllocator;
  devServerManager: DevServerManager;
}
