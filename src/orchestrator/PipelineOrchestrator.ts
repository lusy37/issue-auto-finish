import { cancelUat } from '../e2e/PlaywrightRunner.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { runProcess, splitCommand } from '../utils/process.js';
import { Config } from '../config.js';
import { IssueNotFoundError, InvalidPhaseError, InvalidStateError, PhaseAbortedError } from '../errors/index.js';
import { GitHubClient, GitHubIssue } from '../clients/GitHubClient.js';
import { GitOperations } from '../git/GitOperations.js';
import type { AIRunner } from '../ai-runner/index.js';
import { IssueTracker } from '../tracker/IssueTracker.js';
import { IssueState, type IssueRecord } from '../tracker/IssueState.js';
import { isNoteSyncEnabledForIssue } from '../notesync/NoteSyncSettings.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { WorktreeContext } from '../git/WorktreeContext.js';
import { getLocalIP } from '../utils/network.js';
import type { PhaseContext } from '../phases/BasePhase.js';
import { createPhase } from '../phases/PhaseFactory.js';
import { resolvePipelineMode, getPipelineDef, buildPlanModePipeline, registerPipeline, createLifecycleManager, PipelineDef } from '../pipeline/PipelineDefinition.js';
import { SupplementStore } from '../supplement/SupplementStore.js';
import { githubIssueToDemandSpec } from '../demand/adapters/GitHubAdapter.js';
import { getIssueNumber, getTitle } from '../tracker/IssueRecordHelper.js';
import { eventBus as defaultEventBus, type EventBus } from '../events/EventBus.js';
import {
  applyGateAction,
  buildPipeline,
  GateActionError,
  PLAN_MODE_TRANSITIONS,
  type GateAction,
} from '../orchestration/index.js';
import { TrackerStateStore } from './TrackerStateStore.js';
import { AsyncMutex } from '../utils/AsyncMutex.js';
import { generatePRTitle, generatePRDescription } from '../utils/PullRequestHelper.js';
import { PortAllocator, type PortPair } from '../deploy/PortAllocator.js';
import { DevServerManager } from '../deploy/DevServerManager.js';
import { isE2eEnabledForIssue } from '../e2e/E2eSettings.js';
import { ConflictResolver } from '../git/ConflictResolver.js';
import { getProjectKnowledge } from '../knowledge/index.js';
import { KNOWLEDGE_DEFAULTS } from '../knowledge/KnowledgeDefaults.js';
import { logger as rootLogger } from '../logger.js';
import { runWithIssueContext } from '../context/IssueContext.js';
import { t } from '../i18n/index.js';
import type { OrchestratorDeps, IssueProcessingContext } from './IssueProcessingContext.js';
import { WorkspaceManager, buildSingleRepoWorkspace } from '../workspace/index.js';
import type { WorkspaceConfig } from '../workspace/index.js';
import { executeSetup } from './steps/SetupStep.js';
import { executePhaseLoop } from './steps/PhaseLoopStep.js';
import { executeCompletion } from './steps/CompletionStep.js';
import { handleFailure } from './steps/FailureHandler.js';

export interface PullRequestResult {
  url: string;
  number: number;
}

export interface WorktreeStatus {
  /** worktree 根目录是否存在（false = 已被回收 / 手动删除）。 */
  exists: boolean;
  /** 被 WorktreeReaper 回收的时间戳。 */
  cleanedAt?: string;
  /** 项目子目录（PROJECT_SUBDIR，AI agent 的 cwd）绝对路径。 */
  path?: string;
  /** 当前单仓工作台的持久化与执行上下文。 */
}


const logger = rootLogger.child('PipelineOrchestrator');

export class PipelineOrchestrator {
  private config: Config;
  private github: GitHubClient;
  private mainGit: GitOperations;
  private aiRunner: AIRunner;
  private tracker: IssueTracker;
  private supplementStore?: SupplementStore;
  private mainGitMutex: AsyncMutex;
  private conflictResolver: ConflictResolver;
  private pipelineDef: PipelineDef;
  private portAllocator: PortAllocator;
  private devServerManager: DevServerManager;
  private eventBus: EventBus;
  private workspaceManager: WorkspaceManager;
  private readonly effectiveWorktreeBaseDir: string;
  private pendingActions = new Map<number, 'abort' | 'redo' | 'restart'>();


  cancelUat(issueIid?: number): void { cancelUat(issueIid); }

  getAIRunner(): AIRunner {
    return this.aiRunner;
  }

  /** 替换 AIRunner（用于配置热重载） */
  setAIRunner(runner: AIRunner): void {
    this.aiRunner = runner;
    this.conflictResolver = new ConflictResolver(runner);
    logger.info('AIRunner replaced via hot-reload');
  }

  constructor(
    config: Config,
    github: GitHubClient,
    git: GitOperations,
    aiRunner: AIRunner,
    tracker: IssueTracker,
    supplementStore?: SupplementStore,
    mainGitMutex?: AsyncMutex,
    eventBusInstance?: EventBus,
    wsConfig?: WorkspaceConfig | null,
  ) {
    this.config = config;
    this.github = github;
    this.mainGit = git;
    this.aiRunner = aiRunner;
    this.tracker = tracker;
    this.supplementStore = supplementStore;
    this.mainGitMutex = mainGitMutex ?? new AsyncMutex();
    this.eventBus = eventBusInstance ?? defaultEventBus;
    this.conflictResolver = new ConflictResolver(aiRunner);

    const mode = resolvePipelineMode(config.pipeline?.mode === 'auto' ? undefined : config.pipeline?.mode);
    this.pipelineDef = mode === 'plan-mode'
      ? buildPlanModePipeline({ e2eEnabled: config.e2e.enabled })
      : getPipelineDef(mode);
    registerPipeline(this.pipelineDef);
    logger.info('Pipeline mode resolved', { mode: this.pipelineDef.mode, aiMode: config.ai.mode });

    this.portAllocator = new PortAllocator({
      backendPortBase: config.e2e.backendPortBase,
      frontendPortBase: config.e2e.frontendPortBase,
    });
    this.devServerManager = new DevServerManager({backendCommand: config.preview.backendCommand ? (()=>{const [bin,...args]=splitCommand(config.preview.backendCommand);return {bin,args};})() : undefined, frontendCommand: config.preview.frontendCommand ? (()=>{const [bin,...args]=splitCommand(config.preview.frontendCommand);return {bin,args};})() : undefined, frontendDir: config.preview.frontendDir});

    this.effectiveWorktreeBaseDir = config.project.worktreeBaseDir;

    const effectiveWsConfig = wsConfig ?? buildSingleRepoWorkspace(config.project, config.github.repository);
    this.workspaceManager = new WorkspaceManager({
      wsConfig: effectiveWsConfig,
      worktreeBaseDir: this.effectiveWorktreeBaseDir,
      mainGit: git,
    });
    logger.info('WorkspaceManager initialized', {
      primary: effectiveWsConfig.primary.name,

    });

    this.restorePortAllocations();
  }

  getPortAllocator(): PortAllocator { return this.portAllocator; }
  getDevServerManager(): DevServerManager { return this.devServerManager; }
  getMainGitMutex(): AsyncMutex { return this.mainGitMutex; }
  getTracker(): IssueTracker { return this.tracker; }

  async cleanupStaleState(): Promise<void> {
    logger.info('Cleaning up stale worktree state...');
    let cleaned = 0;
    const repoGitRoot = this.config.project.gitRootDir;

    try {
      const worktrees = await this.mainGit.worktreeList();
      for (const wtDir of worktrees) {
        if (wtDir === repoGitRoot) continue;
        if (!wtDir.includes('/issue-')) continue;

        try {
          const gitFile = path.join(wtDir, '.git');
          try {
            await fs.access(gitFile);
          } catch {
            logger.warn('Worktree corrupted (.git missing), force removing', { dir: wtDir });
            await this.mainGit.worktreeRemove(wtDir, true).catch(() => {});
            await this.mainGit.worktreePrune();
            cleaned++;
            continue;
          }

          const wtGit = new GitOperations(wtDir);

          if (await wtGit.isRebaseInProgress()) {
            logger.warn('Aborting residual rebase in worktree', { dir: wtDir });
            await wtGit.rebaseAbort();
            cleaned++;
          }

          const indexLock = path.join(wtDir, '.git', 'index.lock');
          try {
            await fs.unlink(indexLock);
            logger.warn('Removed stale index.lock', { path: indexLock });
            cleaned++;
          } catch {
            // No lock file — normal
          }
        } catch (err) {
          logger.warn('Failed to clean worktree state', { dir: wtDir, error: (err as Error).message });
        }
      }
    } catch (err) {
      logger.warn('Failed to list worktrees for cleanup', { error: (err as Error).message });
    }

    const mainIndexLock = path.join(repoGitRoot, '.git', 'index.lock');
    try {
      await fs.unlink(mainIndexLock);
      logger.warn('Removed stale main repo index.lock', { path: mainIndexLock });
      cleaned++;
    } catch {
      // No lock file — normal
    }

    logger.info('Stale state cleanup complete', { cleaned });
  }

  /**
   * 重启后清理幽灵端口分配。
   *
   * DevServerManager 的进程句柄仅存于内存，重启后全部丢失。
   * 此时 tracker 中残留的 ports 字段指向不可控的孤儿进程，
   * 必须清理以避免前端误显示 preview 状态。
   */
  private restorePortAllocations(): void {
    for (const record of this.tracker.getAll()) {
      if (record.ports) {
        const number = getIssueNumber(record);
        logger.info('Clearing stale port allocation after restart', { number, ports: record.ports });
        this.tracker.updateState(number, record.state, {
          ports: undefined,
          previewStartedAt: undefined,
        });
      }
    }
  }

  getPipelineDef(): PipelineDef {
    return this.pipelineDef;
  }


  async applyGateAction(number: number, action: GateAction): Promise<void> {
    const record = this.tracker.get(number);
    if (!record) throw new IssueNotFoundError(number);

    const stateStore = new TrackerStateStore(this.tracker);
    const snapshot = stateStore.getSnapshot(number);
    if (snapshot.state.kind !== 'gate-waiting') {
      throw new GateActionError(
        `Gate action requires gate-waiting state, got '${snapshot.state.kind}'`,
        'invalid-state',
      );
    }
    const gatePhaseId = snapshot.state.phaseId;


    const pipeline = buildPipeline(
      {
        e2e: isE2eEnabledForIssue(number, this.tracker, this.config),
      },
      PLAN_MODE_TRANSITIONS,
    );

    const out = applyGateAction({
      state: snapshot.state,
      action,
      pipeline,
      now: new Date().toISOString(),
    });

    // Gate 操作的 sideEffect 当前只有 emit-event，直接转发到 EventBus
    for (const se of out.sideEffects) {
      if (se.kind === 'emit-event') {
        this.eventBus.emitTyped(se.type as never, { issueIid: number, ...se.payload });
      }
    }
    if (out.historyEntry) {
      stateStore.applyTransition(number, {
        nextState: out.nextState,
        nextAttempts: snapshot.attempts,
        historyEntry: out.historyEntry,
      });
    }

    if (action.action === 'reject') {
      // reject 走完 Reducer 后需要补充三个领域副作用，这些不是 Reducer 的纯逻辑职责：
      //   1. 持久化 review-history.json（带 planSnapshot + reviewedSessionId 用于下一轮 PlanPhase）
      //   2. 重置所有阶段的 phaseProgress 为 pending（reject = 流水线从 plan 重启）
      //   3. 同步驳回原因到GitHub Issue 评论
      await this.handleRejectSideEffects(number, action.feedback);
    }

    logger.info('Gate action applied', {
      number, phaseId: gatePhaseId, action: action.action, nextStateKind: out.nextState.kind,
    });
  }

  /**
   * reject 路径专用副作用：持久化反馈 + 重置 phaseProgress + 同步评论。
   *
   * 抽出本方法让 applyGateAction 主体保持「Reducer → SideEffect → StateStore」三段式骨架，
   * reject 特有的领域 IO 收敛在此处。
   */
  private async handleRejectSideEffects(number: number, feedback: string): Promise<void> {
    const record = this.tracker.get(number);
    if (!record) return;

    const wtCtx = this.computeWorktreeContext(number, record.branchName);
    const round = await this.persistRejectFeedback(number, wtCtx.workDir, feedback);
    this.tracker.initPhaseProgress(number, this.getIssueSpecificPipelineDef(number));
    await this.syncRejectFeedbackToIssue(record, number, feedback, round);
  }

  /**
   * 写入审核反馈，返回累计的轮次数。
   *
   * worktree 存在 → 写 worktree 内 review-history.json（带 planSnapshot + reviewedSessionId
   * 供下一轮 PlanPhase resume）；worktree 缺失 → fallback 写全局后备目录（仅保住反馈本身）。
   */
  private async persistRejectFeedback(number: number, workDir: string, feedback: string): Promise<number> {
    if (fsSync.existsSync(workDir)) {
      const planPersistence = new PlanPersistence(workDir, number);
      const snapshot = planPersistence.readFile('01-plan.md') ?? undefined;
      const reviewedSessionId = planPersistence.getPhaseSessionId('plan');
      planPersistence.writeReviewFeedback(feedback, snapshot, reviewedSessionId);
      return planPersistence.readReviewHistory().length;
    }
    PlanPersistence.writeReviewFeedbackBackup(number, feedback);
    return PlanPersistence.readReviewHistoryBackup(number).length;
  }

  /**
   * 把驳回原因同步到GitHub Issue 评论；同步失败不阻塞流水线。
   */
  private async syncRejectFeedbackToIssue(
    record: IssueRecord,
    number: number,
    feedback: string,
    round: number,
  ): Promise<void> {
    if (!isNoteSyncEnabledForIssue(number, this.tracker, this.config)) return;

    const baseUrl = this.config.issueNoteSync.webBaseUrl.replace(/\/$/, '');
    const planFile = '01-plan.md';
    const note = [
      t('api.reviewFeedback', { round }),
      '',
      feedback,
      '',
      '---',
      t('api.viewPlan', { url: `${baseUrl}/doc/${number}/${planFile}` }),
      t('api.viewDetail', { url: `${baseUrl}/?issue=${number}` }),
    ].join('\n');

    try {
      await this.github.createIssueNote(getIssueNumber(record), note);
    } catch (err) {
      logger.warn('Failed to sync reject feedback to issue', {
        number, error: (err as Error).message,
      });
    }
  }

  private emitProgress(issueIid: number, step: string, message: string): void {
    this.eventBus.emitTyped('pipeline:progress', { issueIid, step, message });
  }

  private computeWorktreeContext(issueIid: number, branchName: string): WorktreeContext {
    const primary = this.workspaceManager.buildPrimaryContext(
      issueIid, this.config.project.baseBranch, this.config.project.branchPrefix,
    );
    return {
      gitRootDir: primary.gitRootDir,
      workDir: primary.workDir,
      branchName,
      issueIid,
    };
  }

  private async ensureWorktree(wtCtx: WorktreeContext): Promise<void> {
    const wsCtx = await this.workspaceManager.prepareWorkspace(
      wtCtx.issueIid,
      wtCtx.branchName,
      this.config.project.baseBranch,
    );
    wtCtx.workspace = wsCtx;
  }

  private async cleanupWorktree(wtCtx: WorktreeContext): Promise<void> {
    if (wtCtx.workspace) {
      await this.workspaceManager.cleanupWorkspace(wtCtx.workspace);
      return;
    }
    try {
      await this.mainGit.worktreeRemove(wtCtx.gitRootDir, true);
      logger.info('Worktree cleaned up', { dir: wtCtx.gitRootDir });
    } catch (err) {
      logger.warn('Failed to cleanup worktree', { dir: wtCtx.gitRootDir, error: (err as Error).message });
    }
  }
private async installDependencies(workDir: string): Promise<void> {
 try { await fs.access(path.join(workDir,'package.json')); } catch { return; }
 if(await this.ensureNodeModules(workDir)) return;
 const knowledge=getProjectKnowledge()??KNOWLEDGE_DEFAULTS;
 const [binary,...args]=splitCommand(knowledge.toolchain.installCommand);
 const result=await runProcess(binary,args,{cwd:workDir,timeoutMs:300000});
 if(result.code!==0) throw new Error('安装项目依赖失败：'+result.stderr.slice(-1000));
}
private async ensureNodeModules(workDir: string): Promise<boolean> { try { await fs.access(path.join(workDir, 'node_modules', '.bin')); return true; } catch { return false; } }

  async restartIssue(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    logger.info('Restarting issue — cleaning context', { issueIid, branchName: record.branchName });

    // 设置 pending action，防止旧的 processIssue 循环在 kill 后覆盖状态
    this.pendingActions.set(issueIid, 'restart');

    cancelUat(issueIid);
    this.aiRunner.killByWorkDir(wtCtx.workDir);

    this.stopPreviewServers(issueIid);
    await this.executions.get(issueIid)?.catch(() => {});

    try {
      const deleted = await this.github.cleanupAgentNotes(getIssueNumber(record));
      logger.info('Agent notes cleaned up', { issueIid, deleted });
    } catch (err) {
      logger.warn('Failed to cleanup agent notes', { issueIid, error: (err as Error).message });
    }

    await this.mainGitMutex.runExclusive(async () => {
      await this.cleanupWorktree(wtCtx);
      await this.cleanupWorkspaceRoot(issueIid);
      try { await this.mainGit.deleteBranch(record.branchName); } catch { /* branch may not exist */ }
      try { await this.mainGit.deleteRemoteBranch(record.branchName); } catch { /* remote branch may not exist */ }
    });



    this.tracker.resetFull(issueIid);
    // 清理完毕，删除 pendingAction 防止新的 processIssue 被误拦截
    this.pendingActions.delete(issueIid);
    logger.info('Issue restarted', { issueIid });
  }

  async cancelIssue(issueIid: number): Promise<void> {
    cancelUat(issueIid);
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    logger.info('Cancelling issue — cleaning all resources', { issueIid, branchName: record.branchName });

    this.tracker.updateState(issueIid, IssueState.Cancelled);
    cancelUat(issueIid);
    this.aiRunner.killByWorkDir(wtCtx.workDir);
    await this.executions.get(issueIid)?.catch(() => {});

    // 2. 停止预览服务器
    this.stopPreviewServers(issueIid);

    // 3. 移除GitHub标签（关键步骤！防止 discovery 循环重新发现）
    try {
      await this.github.removeLabelsWithPrefix(getIssueNumber(record), 'auto-finish');
    } catch (err) {
      logger.warn('Failed to remove labels on cancel', { issueIid, error: (err as Error).message });
    }

    // 4. 清理 worktree + 分支
    await this.mainGitMutex.runExclusive(async () => {
      await this.cleanupWorktree(wtCtx);
      await this.cleanupWorkspaceRoot(issueIid);
      try { await this.mainGit.deleteBranch(record.branchName); } catch { /* branch may not exist */ }
      try { await this.mainGit.deleteRemoteBranch(record.branchName); } catch { /* remote branch may not exist */ }
    });

    // 5. 标记为 Skipped（保留记录防止 discovery 重新拾取）
    this.tracker.clearProcessingLock(issueIid);
    this.tracker.updateState(issueIid, IssueState.Cancelled);
    // 6. 清理 E2E 产物

    logger.info('Issue cancelled', { issueIid });
  }

  /**
   * When WorkspaceManager is active, the workspace root (which contains
   * only the primary worktree.  Force-remove the whole workspace root.
   */
  private async cleanupWorkspaceRoot(issueIid: number): Promise<void> {
    if (!this.workspaceManager) return;

    const wsRoot = this.workspaceManager.getWorkspaceRoot(issueIid);
    try {
      await fs.rm(wsRoot, { recursive: true, force: true });
      logger.info('Workspace root cleaned up', { issueIid, dir: wsRoot });
    } catch (err) {
      logger.warn('Failed to cleanup workspace root', { issueIid, dir: wsRoot, error: (err as Error).message });
    }
  }

  retryFromPhase(issueIid: number, phase: string): void {
    if(this.executions.has(issueIid)) throw new InvalidStateError('running','任务仍在执行，请先中止或等待当前执行结束');
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const issueDef = this.getIssueSpecificPipelineDef(issueIid);
    const issueLM = createLifecycleManager(issueDef);
    if (!issueLM.isRetryable(phase)) {
      throw new InvalidPhaseError(phase);
    }

    // Interrupt stale AI processes to prevent them from overwriting the reset state.
    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    cancelUat(issueIid);
    this.aiRunner.killByWorkDir(wtCtx.workDir);

    logger.info('Retrying issue from phase', { issueIid, phase });
    const ok = this.tracker.resetToPhase(issueIid, phase, issueDef);
    if (!ok) {
      throw new InvalidPhaseError(phase);
    }
  }

  // ── 阶段级中止/继续/重做 ──

  abortIssue(issueIid: number): void {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const ABORTABLE = new Set([
      IssueState.PhaseRunning, IssueState.PhaseDone,
      IssueState.PhaseWaiting, IssueState.PhaseApproved,
    ]);
    if (!ABORTABLE.has(record.state)) {
      throw new InvalidStateError(record.state, `Issue #${issueIid} not in abortable state`);
    }

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);

    if (record.state === IssueState.PhaseRunning) {
      // AI 进程运行中 — 设标记后 kill，由 catch 块完成状态转换
      this.pendingActions.set(issueIid, 'abort');
      cancelUat(issueIid);
    this.aiRunner.killByWorkDir(wtCtx.workDir);
    } else {
      // 无进程运行（PhaseDone/PhaseWaiting/PhaseApproved）— 直接暂停
      this.tracker.pauseIssue(issueIid, record.currentPhase ?? '');
    }

    logger.info('Issue abort requested', { issueIid, state: record.state });
  }

  continueIssue(issueIid: number): void {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);
    if (record.state !== IssueState.Paused) {
      throw new InvalidStateError(record.state, `Issue #${issueIid} not in paused state`);
    }

    const issueDef = this.getIssueSpecificPipelineDef(issueIid);
    this.tracker.resumeFromPause(issueIid, issueDef, false);
    logger.info('Issue continued from pause', { issueIid });
  }

  redoPhase(issueIid: number): void {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const REDOABLE = new Set([
      IssueState.Paused, IssueState.PhaseRunning, IssueState.PhaseDone,
      IssueState.PhaseWaiting, IssueState.PhaseApproved,
    ]);
    if (!REDOABLE.has(record.state)) {
      throw new InvalidStateError(record.state, `Issue #${issueIid} not in redoable state`);
    }

    const issueDef = this.getIssueSpecificPipelineDef(issueIid);
    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);

    if (record.state === IssueState.PhaseRunning) {
      // AI 进程运行中 — 设标记后 kill，由 catch 块完成状态转换
      this.pendingActions.set(issueIid, 'redo');
      cancelUat(issueIid);
    this.aiRunner.killByWorkDir(wtCtx.workDir);
    } else if (record.state === IssueState.Paused) {
      const phase = record.pausedAtPhase;
      if (phase) {
        const wtPlan = new PlanPersistence(wtCtx.workDir, issueIid);
        wtPlan.updatePhaseProgress(phase, 'pending');
        this.tracker.updatePhaseProgress(issueIid, phase, {
          status: 'pending', startedAt: undefined, completedAt: undefined, error: undefined,
        });
      }
      this.tracker.resumeFromPause(issueIid, issueDef, true);
      this.eventBus.emitTyped('issue:redone', { issueIid });
    } else {
      // PhaseDone/PhaseWaiting/PhaseApproved — 重置到当前阶段前驱
      const phase = record.currentPhase;
      if (phase) {
        const wtPlan = new PlanPersistence(wtCtx.workDir, issueIid);
        wtPlan.updatePhaseProgress(phase, 'pending');
        // resetToPhase 内部已重置 tracker 的 phaseProgress
        this.tracker.resetToPhase(issueIid, phase, issueDef);
      }
      this.eventBus.emitTyped('issue:redone', { issueIid });
    }

    logger.info('Issue redo requested', { issueIid, state: record.state });
  }

  /**
   * 处理中止/重做的共享逻辑：
   * - abort: 暂停 Issue（保留 session）
   * - redo: 重置阶段（清除 session）
   *
   * 由 catch 块的两条路径（PhaseAbortedError / pendingActions）共用。
   */
  private applyPendingAction(
    action: 'abort' | 'redo',
    issueIid: number,
    wtCtx: WorktreeContext,
    pipelineDef: PipelineDef,
  ): void {
    const rec = this.tracker.get(issueIid);
    // 若 onPhaseFailed 已递增 attempts（state === Failed 时），需回滚
    if (rec?.state === IssueState.Failed && rec.attempts > 0) {
      rec.attempts -= 1;
    }

    if (action === 'abort') {
      this.tracker.pauseIssue(issueIid, rec?.currentPhase ?? '');
    } else {
      const phase = rec?.currentPhase;
      if (phase) {
        const wtPlan = new PlanPersistence(wtCtx.workDir, issueIid);
        wtPlan.updatePhaseProgress(phase, 'pending');
        // resetToPhase 内部已重置 tracker 的 phaseProgress
        this.tracker.resetToPhase(issueIid, phase, pipelineDef);
      }
      this.eventBus.emitTyped('issue:redone', { issueIid: issueIid });
    }
  }


  private getIssueSpecificPipelineDef(issueIid: number): PipelineDef {
    return buildPlanModePipeline({
      e2eEnabled: isE2eEnabledForIssue(issueIid, this.tracker, this.config),
    });
  }

  private readonly executions = new Map<number, Promise<void>>();
  private readonly executionMutex = new AsyncMutex();
  async processIssue(issue: GitHubIssue): Promise<void> {
    const existing = this.executions.get(issue.number);
    if (existing) return existing;
    const running = this.executionMutex.runExclusive(async () => {
      const state = this.tracker.get(issue.number)?.state;
      if (state === IssueState.Cancelled || state === IssueState.Completed) return;
      await runWithIssueContext(issue.number, () => this._processIssueImpl(issue));
    });
    this.executions.set(issue.number, running);
    try { await running; } finally { this.executions.delete(issue.number); }
  }

  private buildDeps(): OrchestratorDeps {
    return {
      config: this.config,
      github: this.github,
      mainGit: this.mainGit,
      mainGitMutex: this.mainGitMutex,
      aiRunner: this.aiRunner,
      tracker: this.tracker,
      supplementStore: this.supplementStore,
      portAllocator: this.portAllocator,
      devServerManager: this.devServerManager,
      eventBus: this.eventBus,
      workspaceManager: this.workspaceManager,
      emitProgress: (number, step, msg) => this.emitProgress(number, step, msg),
      ensureWorktree: (wtCtx) => this.ensureWorktree(wtCtx),
      installDependencies: (workDir) => this.installDependencies(workDir),
      shouldAutoApprove: (labels) => this.shouldAutoApprove(labels),
      shouldDeployServers: (number) => this.shouldDeployServers(number),
      startPreviewServers: (wtCtx, issue) => this.startPreviewServers(wtCtx, issue),
      stopPreviewServers: (number) => this.stopPreviewServers(number),
      tryCreatePullRequest: (issue, branch, workDir, previewUrl) =>
        this.tryCreatePullRequest(issue, branch, workDir, previewUrl),
      buildPreviewUrl: (number) => this.buildPreviewUrl(number),
      getPortsForIssue: (number) => this.portAllocator.getPortsForIssue(number),
      isPreviewRunning: (number) => this.devServerManager.getStatus(number).running,
      consumePendingAction: (number) => {
        const action = this.pendingActions.get(number);
        if (action) this.pendingActions.delete(number);
        return action;
      },
    };
  }

  private async _processIssueImpl(issue: GitHubIssue): Promise<void> {
    const branchName = `${this.config.project.branchPrefix}-${issue.number}`;
    const wtCtx = this.computeWorktreeContext(issue.number, branchName);

    logger.info('Processing issue', {
      number: issue.number, title: issue.title, branchName,
      worktree: wtCtx.gitRootDir,

    });

    const supplement = this.supplementStore?.get(issue.number);
    const demand = githubIssueToDemandSpec(issue, supplement);

    let record = this.tracker.get(issue.number);
    const isRetry = record?.state === IssueState.Failed;
    const startResetGeneration = record?.resetGeneration ?? 0;
    if (isRetry) {
    }

    if (!record) {
      record = this.tracker.create({
        state: IssueState.Pending,
        branchName,
        pipelineMode: this.pipelineDef.mode,
        demandSpec: demand,
      });
    }

    if (!record.pipelineMode) {
      this.tracker.updateState(issue.number, record.state, { pipelineMode: this.pipelineDef.mode } as any);
      record.pipelineMode = this.pipelineDef.mode;
    }

    const issuePipelineDef = this.getIssueSpecificPipelineDef(issue.number);
    const phaseCtx: PhaseContext = {
      demand, branchName, pipelineMode: issuePipelineDef.mode,
      workDir: wtCtx.workDir,
    };
    if (record.ports) {
      phaseCtx.ports = record.ports;
    }

    const ctx: IssueProcessingContext = {
      issue, branchName, wtCtx, record, isRetry,
      pipelineDef: issuePipelineDef,
      demand, phaseCtx,
    };

    const deps = this.buildDeps();

    try {
      if (record.deliveryPending) {
        await executeCompletion(ctx, deps, { serversStarted: this.devServerManager.getStatus(issue.number).running });
        return;
      }
      const { wtGit, wtPlan } = await executeSetup(ctx, deps);

      // Inject workspace layout into phaseCtx after worktree/workspace is prepared
      if (wtCtx.workspace) {
        phaseCtx.workspace = {
          repos: [wtCtx.workspace.primary],
          workspaceRoot: wtCtx.workspace.workspaceRoot,
        };
      }
      const phaseResult = await executePhaseLoop(ctx, deps, wtGit, wtPlan);
      if (phaseResult.paused) return;
      await executeCompletion(ctx, deps, phaseResult);
    } catch (err) {
      if (this.tracker.get(issue.number)?.state === IssueState.Cancelled) return;
      // 拦截用户发起的中止和重做。

      // Path A: PhaseAbortedError — 来自 PhaseLoopStep 阶段间检查（无 AI 运行时）
      if (err instanceof PhaseAbortedError) {
        if (err.action === 'restart') return; // restartIssue 已自行处理所有清理
        this.applyPendingAction(err.action, issue.number, wtCtx, issuePipelineDef);
        return;
      }

      // Path B: pendingActions — AI 进程被 kill 后由 catch 拾取
      const pendingAction = this.pendingActions.get(issue.number);
      if (pendingAction) {
        this.pendingActions.delete(issue.number);
        if (pendingAction === 'restart') return; // restartIssue 已自行处理所有清理
        this.applyPendingAction(pendingAction, issue.number, wtCtx, issuePipelineDef);
        return;
      }

      await handleFailure(err, issue, wtCtx, deps, startResetGeneration);
    }
  }

  private async tryCreatePullRequest(
    issue: GitHubIssue,
    branchName: string,
    workDir: string,
    previewUrl?: string | null,
  ): Promise<PullRequestResult | null> {
    try {
      const title = generatePRTitle(issue.number, issue.title);
      let description = generatePRDescription({
        issueIid: issue.number,
        issueTitle: issue.title,
        issueDescription: issue.description || '',
        branchName,
        planDir: workDir,
      });

      if (previewUrl) {
        description += `\n\n## Preview Environment\n\n🌐 ${previewUrl}`;
      }

      const pr = await this.github.createPullRequest({
        sourceBranch: branchName,
        targetBranch: this.config.project.baseBranch,
        title,
        description,
      });

      logger.info('Merge request created successfully', {
        number: issue.number, prNumber: pr.number, prUrl: pr.html_url,
      });
      return { url: pr.html_url, number: pr.number };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.warn('Failed to create merge request, trying to find existing one', {
        number: issue.number, error: errorMsg,
      });

      return this.tryFindExistingPullRequest(issue.number, branchName);
    }
  }

  private async tryFindExistingPullRequest(
    issueIid: number,
    branchName: string,
  ): Promise<PullRequestResult | null> {
    try {
      const existing = await this.github.findPullRequestByBranch(
        branchName,
        this.config.project.baseBranch,
      );
      if (existing) {
        logger.info('Found existing merge request', {
          number: issueIid, prNumber: existing.number, prUrl: existing.html_url,
        });
        return { url: existing.html_url, number: existing.number };
      }
    } catch (findErr) {
      logger.warn('Failed to find existing merge request', {
        number: issueIid, error: (findErr as Error).message,
      });
    }
    return null;
  }


  private shouldDeployServers(issueIid: number): boolean {
    return isE2eEnabledForIssue(issueIid, this.tracker, this.config)
      || this.config.preview.enabled;
  }

  private shouldAutoApprove(issueLabels: string[]): boolean {
    const autoLabels = this.config.review.autoApproveLabels;
    if (!autoLabels.length) return false;
    return issueLabels.some(l => autoLabels.includes(l));
  }

  private async startPreviewServers(
    wtCtx: WorktreeContext,
    issue: GitHubIssue,
  ): Promise<PortPair | null> {
    try {
      this.emitProgress(issue.number, 'deploy', t('orchestrator.deployProgress'));
      const ports = await this.portAllocator.allocate(issue.number);
      wtCtx.ports = ports;

      this.tracker.updateState(issue.number, this.tracker.get(issue.number)!.state, {
        ports,
        previewStartedAt: new Date().toISOString(),
      } as any);

      await this.devServerManager.startServers(wtCtx, ports);

      const previewUrl = this.buildPreviewUrl(issue.number);
      if (previewUrl) {
        try {
          await this.github.createIssueNote(
            issue.number,
            this.buildPreviewComment(ports, previewUrl),
          );
        } catch {
          // ignore comment failure
        }
      }

      this.emitProgress(issue.number, 'deploy_done', t('orchestrator.deployDoneProgress', { url: previewUrl ?? 'N/A' }));
      this.eventBus.emitTyped('pipeline:progress', {
        issueIid: issue.number,
        step: 'preview_ready',
        message: previewUrl ?? '',
      });

      return ports;
    } catch (err) {
      logger.error('Failed to start preview servers', {
        number: issue.number,
        error: (err as Error).message,
      });
      this.portAllocator.release(issue.number);
      try {
        await this.github.createIssueNote(issue.number,
          `预览服务启动失败: ${(err as Error).message}\n请修正启动命令后重试浏览器验收。`);
      } catch { /* ignore */ }
      return null;
    }
  }

  stopPreviewServers(issueIid: number): void {
    this.devServerManager.stopServers(issueIid);
    this.portAllocator.release(issueIid);
    const record = this.tracker.get(issueIid);
    if (record?.ports) {
      this.tracker.updateState(issueIid, record.state, {
        ports: undefined,
        previewStartedAt: undefined,
      } as any);
    }
  }

  async stopPreviewAndCleanWorktree(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) return;

    this.stopPreviewServers(issueIid);

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    await this.mainGitMutex.runExclusive(async () => {
      await this.cleanupWorktree(wtCtx);
    });
    logger.info('Preview stopped and worktree cleaned', { number: issueIid });
  }

  /**
   * WorktreeReaper 调用：清理已完成 issue 的 worktree/workspace（保留远端分支供 PR）。
   *
   * 幂等：worktree 不存在时安全返回。清理完成后写入 worktreeCleanedAt，使 reaper 后续跳过。
   */
  async cleanupCompletedWorktree(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) return;

    this.stopPreviewServers(issueIid);

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    await this.mainGitMutex.runExclusive(async () => {
      await this.cleanupWorktree(wtCtx);
      await this.cleanupWorkspaceRoot(issueIid);
    });

    this.tracker.updateState(issueIid, record.state, {
      worktreeCleanedAt: new Date().toISOString(),
    });
    logger.info('Completed worktree reaped', { number: issueIid, dir: wtCtx.gitRootDir });
  }

  async restartPreview(issueIid: number): Promise<string> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    if (!fsSync.existsSync(wtCtx.workDir)) {
      throw new InvalidStateError(record.state, 'Worktree no longer exists');
    }

    this.stopPreviewServers(issueIid);

    const ports = await this.portAllocator.allocate(issueIid);
    wtCtx.ports = ports;

    try {
      this.tracker.updateState(issueIid, record.state, {
        ports,
        previewStartedAt: new Date().toISOString(),
      } as any);
      await this.devServerManager.startServers(wtCtx, ports);
    } catch (err) {
      this.portAllocator.release(issueIid);
      this.tracker.updateState(issueIid, record.state, {
        ports: undefined,
        previewStartedAt: undefined,
      } as any);
      throw err;
    }

    const url = this.buildPreviewUrl(issueIid)!;
    logger.info('Preview restarted', { number: issueIid, url });
    return url;
  }

  /** 当前单仓工作台的持久化与执行上下文。 */
  getWorktreeStatus(issueIid: number): WorktreeStatus {
    const record = this.tracker.get(issueIid);
    if (!record) return { exists: false };
    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    return {
      exists: fsSync.existsSync(wtCtx.gitRootDir),
      cleanedAt: record.worktreeCleanedAt,
      path: wtCtx.workDir,
    };
  }

  /**
   * 重建已回收的 worktree：fetch 后基于分支重新创建 worktree（含多仓 workspace）。
   * 重建后清除回收标记并重置保留期计时（completedAt = now），避免刚重建即被 reaper 再次回收。
   */
  async rebuildWorktree(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    logger.info('Rebuilding worktree', { issueIid, branchName: record.branchName });
    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    await this.mainGitMutex.runExclusive(async () => {
      await this.mainGit.fetch();
      await this.ensureWorktree(wtCtx);
    });

    this.tracker.updateState(issueIid, record.state, {
      worktreeCleanedAt: undefined,
      completedAt: new Date().toISOString(),
    });
    logger.info('Worktree rebuilt', { issueIid, dir: wtCtx.gitRootDir });
  }

  getPreviewHost(): string {
    if (this.config.preview.host) return this.config.preview.host;
    return getLocalIP();
  }

  buildPreviewUrl(issueIid: number): string | null {
    const ports = this.portAllocator.getPortsForIssue(issueIid);
    if (!ports) return null;
    const host = this.getPreviewHost();
    return `http://${host}:${ports.frontendPort}`;
  }

  private buildPreviewComment(ports: PortPair, previewUrl: string): string {
    const host = this.getPreviewHost();
    const ttlHours = Math.round(this.config.preview.ttlMs / (60 * 60 * 1000));
    return [
      t('orchestrator.previewComment.title'),
      '',
      t('orchestrator.previewComment.tableHeader'),
      t('orchestrator.previewComment.tableSep'),
      `| ${t('orchestrator.previewComment.frontend')} | ${previewUrl} |`,
      `| ${t('orchestrator.previewComment.backendApi')} | http://${host}:${ports.backendPort}/api |`,
      '',
      t('orchestrator.previewComment.hint'),
      t('orchestrator.previewComment.expiry', { hours: ttlHours }),
    ].join('\n');
  }

  async resolveConflict(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    const baseBranch = this.config.project.baseBranch;
    const branchName = record.branchName;

    logger.info('Starting conflict resolution', { issueIid, branchName, baseBranch });

    // 1. Update state
    this.tracker.updateState(issueIid, IssueState.ResolvingConflict);
    this.eventBus.emitTyped('conflict:started', { issueIid });

    // 2. Comment on issue
    try {
      await this.github.createIssueNote(
        getIssueNumber(record),
        t('conflict.startComment', { branch: branchName, baseBranch }),
      );
    } catch { /* ignore */ }

    const wtCtx = this.computeWorktreeContext(issueIid, branchName);

    try {
      // 3. Fetch + ensure worktree
      await this.mainGitMutex.runExclusive(async () => {
        await this.mainGit.fetch();
        await this.ensureWorktree(wtCtx);
      });

      const wtGit = new GitOperations(wtCtx.gitRootDir);

      // 4. Checkout branch
      await wtGit.checkout(branchName);

      // 5–6. Rebase + resolve conflicts using shared ConflictResolver
      await this.conflictResolver.resolve({
        wtGit,
        targetRef: `origin/${baseBranch}`,
        workDir: wtCtx.workDir,
        branchName,
        contextId: issueIid,
        phaseTimeoutMs: this.config.ai.phaseTimeoutMs,
        onEvent: (event) => {
          this.eventBus.emitTyped('agent:output', {
            issueIid,
            phase: 'conflict-resolve',
            event,
          });
        },
      });

      // If resolve() returned without throwing, rebase succeeded (with or without conflict resolution).

      // 7. Run verification
      logger.info('Running verification after conflict resolution', { issueIid });
      const wtPlan = new PlanPersistence(wtCtx.workDir, issueIid);
      wtPlan.ensureDir();

      const verifyPhase = createPhase('verify', this.aiRunner, wtGit, wtPlan, this.config);

      const verifyCtx: PhaseContext = {
        demand: {
          demandId: `gh-${issueIid}`,
          sourceRef: {
            source: 'github-issue',
            externalId: String(getIssueNumber(record)),
            displayId: String(issueIid),
          },
          title: getTitle(record),
          description: '',
          createdAt: record.createdAt,
        },
        branchName,
        pipelineMode: record.pipelineMode,
      };

      const verifyIntent = await verifyPhase.run(verifyCtx);
      if (verifyIntent.kind === 'failed') {
        const errMsg = verifyIntent.error.message || 'Verification failed after conflict resolution';
        throw new (await import('../errors/index.js')).AIExecutionError('verify', errMsg, {
          output: verifyIntent.error.rawOutput ?? '',
          exitCode: 1,
        });
      }
      if (verifyIntent.kind !== 'completed') {
        throw new (await import('../errors/index.js')).AIExecutionError(
          'verify',
          `Unexpected verify intent kind '${verifyIntent.kind}' after conflict resolution`,
          { output: '', exitCode: 1 },
        );
      }

      // 8. Force push
      await wtGit.forcePush(branchName);

      // 9. Update state — 重置 worktree 延迟清理计时（冲突解决后 worktree 重新可用）
      this.tracker.updateState(issueIid, IssueState.Completed, {
        completedAt: new Date().toISOString(),
        worktreeCleanedAt: undefined,
      });
      this.eventBus.emitTyped('conflict:resolved', { issueIid });

      // 10. Comment on Issue/PR
      try {
        await this.github.createIssueNote(
          getIssueNumber(record),
          t('conflict.resolvedComment', { branch: branchName, baseBranch }),
        );
      } catch { /* ignore */ }

      await this.commentOnMr(record.prUrl, t('conflict.mrResolvedComment'));

      logger.info('Conflict resolution completed', { issueIid });
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error('Conflict resolution failed', { issueIid, error: errorMsg });

      // Try to abort any in-progress rebase
      try {
        const wtGit = new GitOperations(wtCtx.gitRootDir);
        if (await wtGit.isRebaseInProgress()) {
          await wtGit.rebaseAbort();
        }
      } catch { /* ignore abort failure */ }

      this.tracker.markFailed(issueIid, errorMsg.slice(0, 500), IssueState.ResolvingConflict);
      this.eventBus.emitTyped('conflict:failed', { issueIid, error: errorMsg });

      try {
        await this.github.createIssueNote(
          getIssueNumber(record),
          t('conflict.failedComment', { error: errorMsg }),
        );
      } catch { /* ignore */ }
    }
  }

  private extractMrIidFromUrl(prUrl: string): number | null {
    const match = prUrl.match(/pull\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  private async commentOnMr(prUrl: string | undefined, body: string): Promise<void> {
    if (!prUrl) return;
    const prNumber = this.extractMrIidFromUrl(prUrl);
    if (!prNumber) return;
    try {
      await this.github.createPullRequestNote(prNumber, body);
    } catch (err) {
      logger.warn('Failed to comment on PR', { prNumber, error: (err as Error).message });
    }
  }
}
