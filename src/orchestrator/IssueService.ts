import { isShuttingDown } from '../shutdown/ShutdownSignal.js';
import { randomUUID } from 'node:crypto';
import { assertOwnedDirectory, isInside } from '../dag/TaskGraphExecutor.js';
import { cancelUat } from '../e2e/PlaywrightRunner.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { runProcess, splitCommand } from '../utils/process.js';
import { Config } from '../config.js';
import { IssueNotFoundError, InvalidPhaseError, InvalidStateError } from '../errors/index.js';
import { GitHubClient, GitHubIssue } from '../clients/GitHubClient.js';
import { GitOperations } from '../git/GitOperations.js';
import type { AIRunner } from '../ai-runner/index.js';
import { IssueTracker } from '../tracker/IssueTracker.js';
import { IssueState, type IssueRecord } from '../tracker/IssueState.js';
import { isNoteSyncEnabledForIssue } from '../notesync/NoteSyncSettings.js';
import type { WorktreeContext } from '../git/WorktreeContext.js';
import { getLocalIP } from '../utils/network.js';
import type { PhaseContext } from '../phases/BasePhase.js';
import { resolvePipelineMode, getPipelineDef, buildPlanModePipeline, registerPipeline, createLifecycleManager, PipelineDef } from '../pipeline/PipelineMetadata.js';
import { SupplementStore } from '../supplement/SupplementStore.js';
import { githubIssueToDemandSpec } from '../demand/adapters/GitHubAdapter.js';
import { getIssueNumber } from '../tracker/IssueRecordHelper.js';
import { eventBus as defaultEventBus, type EventBus } from '../events/EventBus.js';
import { GateActionError, type GateAction } from '../orchestration/index.js';
import { IssueWorkflow, ReviewConflictError } from './IssueWorkflow.js';
import { AsyncMutex } from '../utils/AsyncMutex.js';
import { PortAllocator, type PortPair } from '../preview/PortAllocator.js';
import { DevServerManager } from '../preview/DevServerManager.js';
import { isE2eEnabledForIssue } from '../e2e/E2eSettings.js';
import { getProjectKnowledge } from '../knowledge/index.js';
import { KNOWLEDGE_DEFAULTS } from '../knowledge/KnowledgeDefaults.js';
import { logger as rootLogger } from '../logger.js';
import { runWithIssueContext } from '../context/IssueContext.js';
import { t } from '../i18n/index.js';
import type { OrchestratorDeps, IssueProcessingContext } from './IssueProcessingContext.js';
import { WorkspaceManager, buildSingleRepoWorkspace } from '../workspace/index.js';
import type { WorkspaceConfig } from '../workspace/index.js';
import { executeSetup } from './steps/SetupStep.js';
import { runWorkflow } from './steps/RunWorkflowStep.js';
import { handleFailure } from './steps/FailureHandler.js';



export interface WorktreeStatus {
  /** worktree 根目录是否存在（false = 已被回收 / 手动删除）。 */
  exists: boolean;
  /** 被 WorktreeReaper 回收的时间戳。 */
  cleanedAt?: string;
  /** 项目子目录（PROJECT_SUBDIR，AI agent 的 cwd）绝对路径。 */
  path?: string;
  /** 当前单仓工作台的持久化与执行上下文。 */
}


const logger = rootLogger.child('IssueService');

export class IssueService {
  private config: Config;
  private github: GitHubClient;
  private mainGit: GitOperations;
  private aiRunner: AIRunner;
  private tracker: IssueTracker;
  private supplementStore?: SupplementStore;
  private mainGitMutex: AsyncMutex;
  private pipelineDef: PipelineDef;
  private portAllocator: PortAllocator;
  private devServerManager: DevServerManager;
  private eventBus: EventBus;
  private workspaceManager: WorkspaceManager;
  private readonly effectiveWorktreeBaseDir: string;


  cancelUat(issueIid?: number): void { cancelUat(issueIid); }

  getAIRunner(): AIRunner {
    return this.aiRunner;
  }

  /** 替换 AIRunner（用于配置热重载） */
  setAIRunner(runner: AIRunner): void {
    this.aiRunner = runner;
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
    this.devServerManager = new DevServerManager({
      onProcessStarted: (number, pid, workDir) => {
        const callId = randomUUID();
        this.tracker.transaction(number, record => {
          const run = record.run!;
          if (run.stopIntent) throw new Error('已停止的 Issue 不能启动预览');
          run.calls[callId] = { identity: { issueNumber: number, planRevision: run.planRevision, buildGeneration: run.buildGeneration, dispatchId: run.dispatchId ?? 'preview', taskId: '$preview', attemptNo: 1, callId }, pid, workDir, status: 'running', startedAt: new Date().toISOString() };
        });
        return callId;
      },
      onProcessExited: (number, callId) => this.tracker.transaction(number, record => { const call = record.run!.calls[callId]; if (call) { call.status = 'exited'; call.exitedAt = new Date().toISOString(); } }),
      backendCommand: config.preview.backendCommand ? (()=>{const [bin,...args]=splitCommand(config.preview.backendCommand);return {bin,args};})() : undefined, frontendCommand: config.preview.frontendCommand ? (()=>{const [bin,...args]=splitCommand(config.preview.frontendCommand);return {bin,args};})() : undefined, frontendDir: config.preview.frontendDir});

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

  /** 仅检查登记目录；变基恢复、锁文件核对都归所属 Issue 的恢复协议处理。 */
  async cleanupStaleState(): Promise<void> {
    for (const record of this.tracker.getAll()) {
      const directory = this.computeWorktreeContext(getIssueNumber(record), record.branchName).gitRootDir;
      if (fsSync.existsSync(directory) && !fsSync.existsSync(path.join(directory, '.git'))) logger.warn('工作目录缺少 Git 登记，请人工核对', { directory });
    }
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


  async applyGateAction(number: number, action: GateAction, planRevision?: number): Promise<void> {
    await this.executions.get(number);
    const record = this.tracker.get(number);
    if (!record) throw new IssueNotFoundError(number);
    if (planRevision === undefined || planRevision !== record.run!.planRevision) throw new GateActionError('审核计划版本已过期，请刷新页面', 'invalid-state');
    if (action.action === 'supplement') throw new GateActionError('请通过补充需求入口更新计划', 'invalid-state');
    const workflow = new IssueWorkflow({
      tracker: this.tracker, number, events: this.eventBus,
      maxRetries: this.config.poll.maxRetries, maxRepairs: this.config.verifyFixLoop.maxIterations,
      context: { issueIid: number, demand: record.demandSpec!, branchName: record.branchName, workDir: this.computeWorktreeContext(number, record.branchName).workDir, pipelineMode: 'plan-mode' },
      runner: { run: async () => { throw new Error('审核请求不能执行开发阶段'); } },
    });
    try {
      await workflow.resumeReview({ ...action, planRevision });
    } catch (error) {
      if (error instanceof ReviewConflictError) throw new GateActionError(error.message, 'invalid-state');
      throw error;
    }
    if (action.action === 'reject') {
      const current = this.tracker.get(number)!;
      await this.syncRejectFeedbackToIssue(current, number, action.feedback, current.run!.reviewHistory?.length ?? 1);
    }

    logger.info('Gate action applied', {
      number, phaseId: 'review', action: action.action, planRevision,
    });
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
    assertOwnedDirectory(this.config.project.worktreeBaseDir, wtCtx.gitRootDir);
    const wsCtx = await this.workspaceManager.prepareWorkspace(
      wtCtx.issueIid,
      wtCtx.branchName,
      this.config.project.baseBranch,
    );
    wtCtx.workspace = wsCtx;
  }

  private async cleanupWorktree(wtCtx: WorktreeContext): Promise<void> {
    const record = this.tracker.get(wtCtx.issueIid);
    if (this.executions.has(wtCtx.issueIid) || record?.run?.recoveryRequired || Object.values(record?.run?.calls ?? {}).some(call => call.status !== 'exited')) throw new Error('目录仍有执行或恢复引用，不能清理');
    assertOwnedDirectory(this.config.project.worktreeBaseDir, wtCtx.gitRootDir);
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
private async installDependencies(workDir: string, signal?: AbortSignal, force = false): Promise<void> {
 try { await fs.access(path.join(workDir,'package.json')); } catch { return; }
 if(!force && await this.ensureNodeModules(workDir)) return;
 const knowledge=getProjectKnowledge()??KNOWLEDGE_DEFAULTS;
 const [binary,...args]=splitCommand(knowledge.toolchain.installCommand);
 const result=await runProcess(binary,args,{cwd:workDir,timeoutMs:300000,signal});
 if(result.code!==0) throw new Error('安装项目依赖失败：'+result.stderr.slice(-1000));
}
private async ensureNodeModules(workDir: string): Promise<boolean> { try { await fs.access(path.join(workDir, 'node_modules', '.bin')); return true; } catch { return false; } }

  private async stopIssue(issueIid: number, kind: 'pause' | 'cancel' | 'redo'): Promise<void> {
    this.tracker.transaction(issueIid, record => {
      record.run!.stopIntent = { kind, requestedAt: new Date().toISOString() };
      record.state = kind === 'cancel' ? IssueState.Cancelled : IssueState.Paused;
      record.pausedAtPhase = record.currentPhase ?? 'plan';
      record.orchestrationState = kind === 'cancel' ? { kind: 'pipeline-completed' } : { kind: 'paused', phaseId: record.pausedAtPhase };
    });
    this.controllers.get(issueIid)?.abort();
    cancelUat(issueIid);
    await this.executions.get(issueIid)?.catch(() => {});
    await this.stopPreviewServers(issueIid);
    this.confirmStoppedCalls(issueIid);
  }

  private async recoverExecution(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid)!;
    if (record.run!.stopIntent || [IssueState.Paused, IssueState.Cancelled, IssueState.Failed].includes(record.state)) throw new Error('停止或人工处理状态不自动恢复');
    for (const call of Object.values(record.run!.calls)) {
      if (call.status === 'exited') continue;
      if (call.pid) {
        try { process.kill(call.pid, 0); throw new Error(`旧调用进程 ${call.pid} 尚未确认退出，请人工核对`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    for (const file of record.run!.temporaryFiles ?? []) {
      assertOwnedDirectory(this.config.project.worktreeBaseDir, file);
      if (!/^\.iaf-uat-[a-f0-9-]+\.config\.ts$/.test(path.basename(file))) throw new Error('临时文件登记无效，请人工核对');
      fsSync.rmSync(file, { force: true });
    }
    this.tracker.transaction(issueIid, current => {
      const run = current.run!;
      const uncertain = Object.values(run.tasks).some(task => task.status === 'running' && !task.success) || (Object.values(run.calls).some(call => call.identity.dispatchId === run.dispatchId && call.identity.taskId.startsWith('$phase') && call.status !== 'exited'));
      if (uncertain) {
        const phase = current.currentPhase ?? 'build';
        if ((run.retryUsed[phase] ?? 0) >= this.config.poll.maxRetries) throw new Error('恢复未知执行所需的自动重试额度已用完');
        run.retryUsed[phase] = (run.retryUsed[phase] ?? 0) + 1;
      }
      for (const call of Object.values(run.calls)) if (call.status !== 'exited') { call.status = 'exited'; call.exitedAt = new Date().toISOString(); }
      for (const task of Object.values(run.tasks)) if (task.status === 'running' && !task.success) task.status = 'uncertain';
      run.temporaryFiles = [];
      run.recoveryRequired = false;
    });
  }

  /** 显式继续允许核对已退出的孤儿调用，但绝不抢占仍存活或身份不明的进程。 */
  private confirmStoppedCalls(issueIid: number): void {
    const record = this.tracker.get(issueIid)!;
    for (const call of Object.values(record.run!.calls)) {
      if (call.status === 'exited') continue;
      if (call.status !== 'queued' && !call.pid) throw new Error('调用缺少进程凭证，目录保持隔离，请人工核对');
      if (call.pid) {
        try { process.kill(call.pid, 0); throw new Error(`旧进程 ${call.pid} 尚未退出`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    this.tracker.transaction(issueIid, current => {
      for (const call of Object.values(current.run!.calls)) if (call.status !== 'exited') { call.status = 'exited'; call.exitedAt = new Date().toISOString(); }
      current.run!.recoveryRequired = false;
    });
  }

  async restartIssue(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);
    if (record.run!.delivery?.prNumber) {
      const pr = await this.github.getPullRequestDetail(record.run!.delivery.prNumber);
      if (pr.state === 'merged') throw new Error('原 PR 已合并，请为后续需求创建新 Issue');
      if (pr.state === 'closed') throw new Error('请先在 GitHub 重开原 PR，再完整重做');
    }
    await this.stopIssue(issueIid, 'redo');
    const wtCtx = this.computeWorktreeContext(issueIid, record.branchName);
    assertOwnedDirectory(this.config.project.worktreeBaseDir, wtCtx.gitRootDir);
    await this.mainGitMutex.runExclusive(async () => {
      await this.mainGit.fetch();
      // 已回收目录也必须先重建，再统一重置；保留分支和 PR 身份不代表沿用旧交付代码。
      if (!fsSync.existsSync(path.join(wtCtx.gitRootDir, '.git'))) await this.ensureWorktree(wtCtx);
      await new GitOperations(wtCtx.gitRootDir).resetOwned(`origin/${this.config.project.baseBranch}`);
    });
    this.tracker.resetFull(issueIid);
  }

  async cancelIssue(issueIid: number): Promise<void> {
    if (!this.tracker.get(issueIid)) throw new IssueNotFoundError(issueIid);
    await this.stopIssue(issueIid, 'cancel');
    // 已发布分支及 PR 身份保留，诊断目录由保留期策略处理。
    await this.github.removeLabelsWithPrefix(issueIid, 'auto-finish');
  }

  /**
   * When WorkspaceManager is active, the workspace root (which contains
   * only the primary worktree.  Force-remove the whole workspace root.
   */
  private async cleanupWorkspaceRoot(issueIid: number): Promise<void> {
    if (!this.workspaceManager) return;

    const wsRoot = this.workspaceManager.getWorkspaceRoot(issueIid);
    assertOwnedDirectory(this.config.project.worktreeBaseDir, wsRoot);
    try {
      await fs.rm(wsRoot, { recursive: true, force: true });
      logger.info('Workspace root cleaned up', { issueIid, dir: wsRoot });
    } catch (err) {
      logger.warn('Failed to cleanup workspace root', { issueIid, dir: wsRoot, error: (err as Error).message });
    }
  }

  retryIssue(issueIid: number): boolean {
    if (this.executions.has(issueIid)) throw new InvalidStateError('running', '旧执行尚未退出，请稍后重试');
    const record = this.tracker.get(issueIid);
    if (!record || record.state !== IssueState.Failed) return false;
    this.confirmStoppedCalls(issueIid);
    return this.tracker.resetForRetry(issueIid);
  }

  retryFromPhase(issueIid: number, phase: string): void {
    if(this.executions.has(issueIid)) throw new InvalidStateError('running','任务仍在执行，请先中止或等待当前执行结束');
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);

    if (phase === 'plan' && Object.values(record.run!.tasks).some(task => task.attemptNo > 0)) throw new Error('已有合并结果，请使用完整重做来重新规划');
    const issueDef = this.getIssueSpecificPipelineDef(issueIid);
    const issueLM = createLifecycleManager(issueDef);
    if (!issueLM.isRetryable(phase)) {
      throw new InvalidPhaseError(phase);
    }

    this.confirmStoppedCalls(issueIid);

    logger.info('Retrying issue from phase', { issueIid, phase });
    const ok = this.tracker.resetToPhase(issueIid, phase, issueDef);
    if (!ok) {
      throw new InvalidPhaseError(phase);
    }
  }

  // ── 阶段级中止/继续/重做 ──

  async abortIssue(issueIid: number): Promise<void> {
    if (!this.tracker.get(issueIid)) throw new IssueNotFoundError(issueIid);
    await this.stopIssue(issueIid, 'pause');
  }

  continueIssue(issueIid: number): void {
    if (this.executions.has(issueIid)) throw new Error('停止仍在进行，请等待进程退出');
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);
    if (record.state !== IssueState.Paused) {
      throw new InvalidStateError(record.state, `Issue #${issueIid} not in paused state`);
    }

    this.confirmStoppedCalls(issueIid);
    this.tracker.resumeFromPause(issueIid);
    logger.info('Issue continued from pause', { issueIid });
  }

  async redoPhase(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) throw new IssueNotFoundError(issueIid);
    const phase = record.pausedAtPhase ?? record.currentPhase ?? 'plan';
    if (phase === 'plan' && Object.values(record.run!.tasks).some(task => task.attemptNo > 0)) throw new Error('任务图已执行，请使用完整重做重新规划');
    await this.stopIssue(issueIid, 'pause');
    this.tracker.resetToPhase(issueIid, phase, this.getIssueSpecificPipelineDef(issueIid));
    this.tracker.updatePhaseProgress(issueIid, phase, { sessionId: undefined });
  }

  async stopExecutions(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.executions.values());
  }


  private getIssueSpecificPipelineDef(issueIid: number): PipelineDef {
    return buildPlanModePipeline({
      e2eEnabled: isE2eEnabledForIssue(issueIid, this.tracker, this.config),
    });
  }

  private readonly executions = new Map<number, Promise<void>>();
  private readonly controllers = new Map<number, AbortController>();
  async processIssue(issue: GitHubIssue): Promise<void> {
    const existing = this.executions.get(issue.number);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(issue.number, controller);
    const running = Promise.resolve().then(async () => {
      const state = this.tracker.get(issue.number)?.state;
      if (state === IssueState.Cancelled || state === IssueState.Completed) return;
      await runWithIssueContext(issue.number, () => this._processIssueImpl(issue), controller.signal, {
        processStarted: (pid, workDir) => {
          const callId = randomUUID();
          this.tracker.transaction(issue.number, record => {
            const run = record.run!;
            if (run.stopIntent) throw new Error('停止后不再启动命令');
            run.calls[callId] = { identity: { issueNumber: issue.number, planRevision: run.planRevision, buildGeneration: run.buildGeneration, dispatchId: run.dispatchId!, taskId: '$process', attemptNo: run.phaseExecutions[record.currentPhase ?? 'setup'] ?? 1, callId }, pid, workDir, status: 'running', startedAt: new Date().toISOString() };
          });
          return callId;
        },
        processExited: callId => { this.tracker.transaction(issue.number, record => { const call = record.run!.calls[callId]; if (call) { call.status = 'exited'; call.exitedAt = new Date().toISOString(); } }); },
      });
    });
    this.executions.set(issue.number, running);
    try { await running; } finally { this.executions.delete(issue.number); this.controllers.delete(issue.number); }
  }

  private buildDeps(issueNumber?: number): OrchestratorDeps {
    return {
      config: this.config,
      signal: issueNumber === undefined ? undefined : this.controllers.get(issueNumber)?.signal,
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
      installDependencies: (workDir, signal, force) => this.installDependencies(workDir, signal ?? (issueNumber === undefined ? undefined : this.controllers.get(issueNumber)?.signal), force),
      shouldAutoApprove: (labels) => this.shouldAutoApprove(labels),
      shouldDeployServers: (number) => this.shouldDeployServers(number),
      startPreviewServers: (wtCtx, issue) => this.startPreviewServers(wtCtx, issue),
      stopPreviewServers: (number) => this.stopPreviewServers(number),
      buildPreviewUrl: (number) => this.buildPreviewUrl(number),
      getPortsForIssue: (number) => this.portAllocator.getPortsForIssue(number),
      isPreviewRunning: (number) => this.devServerManager.getStatus(number).running,
    };
  }

  private async _processIssueImpl(issue: GitHubIssue): Promise<void> {
    const branchName = this.tracker.get(issue.number)?.branchName ?? `${this.config.project.branchPrefix}-${issue.number}`;
    const wtCtx = this.computeWorktreeContext(issue.number, branchName);

    logger.info('Processing issue', {
      number: issue.number, title: issue.title, branchName,
      worktree: wtCtx.gitRootDir,

    });

    const supplement = this.supplementStore?.get(issue.number);
    const existingDemand = this.tracker.get(issue.number);
    const approvedDemand = existingDemand?.run?.review?.decision === 'approved' ? this.tracker.store.readPlan(issue.number, existingDemand.run.planRevision, existingDemand.run.planDigest).demand : undefined;
    const demand = approvedDemand ?? (existingDemand?.run?.review?.decision !== 'rejected' && existingDemand?.state !== IssueState.Pending && existingDemand?.demandSpec ? existingDemand.demandSpec : githubIssueToDemandSpec(issue, supplement));

    let record = this.tracker.get(issue.number);
    const isRetry = record?.state === IssueState.Failed;
    const startResetGeneration = record?.resetGeneration ?? 0;

    if (!record) {
      record = this.tracker.create({
        state: IssueState.Pending,
        branchName,
        pipelineMode: this.pipelineDef.mode,
        demandSpec: demand,
      });
    }

    if (!record.pipelineMode) {
      this.tracker.updateState(issue.number, record.state, { pipelineMode: this.pipelineDef.mode });
      record.pipelineMode = this.pipelineDef.mode;
    }

    if (record.run!.recoveryRequired) {
      try { await this.recoverExecution(issue.number); }
      catch (error) { this.tracker.markFailed(issue.number, (error as Error).message, record.state, false); return; }
    }
    this.tracker.transaction(issue.number, current => {
      if (current.run!.stopIntent) throw new Error('任务已停止');
      current.run!.dispatchId = randomUUID();
      current.demandSpec = demand;
    });
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

    const deps = this.buildDeps(issue.number);

    try {
      const { wtGit, wtPlan } = await executeSetup(ctx, deps);

      // Inject workspace layout into phaseCtx after worktree/workspace is prepared
      if (wtCtx.workspace) {
        phaseCtx.workspace = {
          repos: [wtCtx.workspace.primary],
          workspaceRoot: wtCtx.workspace.workspaceRoot,
        };
      }
      await runWorkflow(ctx, deps, wtGit, wtPlan);
    } catch (err) {
      if (this.tracker.get(issue.number)?.run?.stopIntent) return;

      if (isShuttingDown()) return;
      if (this.tracker.store.isBlocked(issue.number)) throw err;
      await handleFailure(err, issue, wtCtx, deps, startResetGeneration);
    }
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
      });

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

  async stopPreviewServers(issueIid: number): Promise<void> {
    this.devServerManager.stopServers(issueIid);
    await this.devServerManager.waitForStopped(issueIid);
    this.portAllocator.release(issueIid);
    const record = this.tracker.get(issueIid);
    if (record?.ports) {
      this.tracker.updateState(issueIid, record.state, {
        ports: undefined,
        previewStartedAt: undefined,
      });
    }
  }

  async stopPreviewAndCleanWorktree(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) return;

    await this.stopPreviewServers(issueIid);

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
  /** 仅回收没有任务或进程引用的历史尝试；当前任务、暂停和恢复目录始终保留。 */
  async cleanupExpiredTaskWorkspaces(retentionMs: number): Promise<void> {
    for (const record of this.tracker.getAll()) {
      const number = getIssueNumber(record);
      for (const workspace of record.run?.workspaces ?? []) {
        if (workspace.cleanedAt || Date.now() - Date.parse(workspace.createdAt) < retentionMs) continue;
        await this.mainGitMutex.runExclusive(async () => {
          const current = this.tracker.get(number)!;
          if (current.run!.recoveryRequired || current.state === IssueState.Paused || Object.values(current.run!.tasks).some(task => task.workDir === workspace.directory) || Object.values(current.run!.calls).some(call => call.status !== 'exited' && (call.workDir === workspace.directory || isInside(workspace.directory, call.workDir)))) return;
          assertOwnedDirectory(this.config.project.worktreeBaseDir, workspace.directory);
          if (fsSync.existsSync(workspace.directory)) await this.mainGit.worktreeRemove(workspace.directory, true);
          if (await this.mainGit.branchExists(workspace.branch)) await this.mainGit.deleteBranch(workspace.branch);
          this.tracker.transaction(number, latest => { const saved = latest.run!.workspaces!.find(entry => entry.directory === workspace.directory); if (saved) saved.cleanedAt = new Date().toISOString(); });
        });
      }
    }
  }

  async cleanupCompletedWorktree(issueIid: number): Promise<void> {
    const record = this.tracker.get(issueIid);
    if (!record) return;

    if (record.state !== IssueState.Completed || record.run?.recoveryRequired || this.executions.has(issueIid) || Object.values(record.run?.calls ?? {}).some(call => call.status !== 'exited')) throw new Error('任务仍需要工作目录，不能清理');
    for (const workspace of record.run?.workspaces ?? []) {
      if (workspace.cleanedAt) continue;
      assertOwnedDirectory(this.config.project.worktreeBaseDir, workspace.directory);
      await this.mainGitMutex.runExclusive(async () => {
        if (fsSync.existsSync(workspace.directory)) await this.mainGit.worktreeRemove(workspace.directory, true);
        if (await this.mainGit.branchExists(workspace.branch)) await this.mainGit.deleteBranch(workspace.branch);
      });
      this.tracker.transaction(issueIid, current => { const target = current.run!.workspaces!.find(w => w.directory === workspace.directory); if (target) target.cleanedAt = new Date().toISOString(); });
    }
    await this.stopPreviewServers(issueIid);

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

    await this.stopPreviewServers(issueIid);

    const ports = await this.portAllocator.allocate(issueIid);
    wtCtx.ports = ports;

    try {
      this.tracker.updateState(issueIid, record.state, {
        ports,
        previewStartedAt: new Date().toISOString(),
      });
      await this.devServerManager.startServers(wtCtx, ports);
    } catch (err) {
      this.portAllocator.release(issueIid);
      this.tracker.updateState(issueIid, record.state, {
        ports: undefined,
        previewStartedAt: undefined,
      });
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
    if (this.executions.has(issueIid)) throw new Error('任务仍在执行');
    const record = this.tracker.get(issueIid);
    if (!record?.run?.delivery?.prNumber) throw new Error('任务尚未关联工作台 PR');
    const pr = await this.github.getPullRequestDetail(record.run.delivery.prNumber);
    if (pr.state !== 'open') throw new Error('只有开放的原 PR 可以修复冲突');
    if (record.run.repairRounds >= this.config.verifyFixLoop.maxIterations) throw new Error('集成自动修复额度已用完');
    await this.mainGitMutex.runExclusive(() => this.mainGit.fetch());
    this.tracker.transaction(issueIid, current => {
      const run = current.run!;
      if (this.executions.has(issueIid) || run.stopIntent || run.workflow.generation !== record.run!.workflow.generation || run.buildGeneration !== record.run!.buildGeneration) throw new Error('任务执行状态已改变，请重新确认冲突修复');
      if (run.repairRounds >= this.config.verifyFixLoop.maxIterations) throw new Error('集成自动修复额度已用完');
      run.repairRounds++;
      run.buildEntry = 'repair-integration';
      run.repairs.push({ round: run.repairRounds, source: 'pr-conflict', report: `将 origin/${this.config.project.baseBranch} 合并到当前分支并解决冲突，保留父需求和基线双方修改。随后重新完整验证。` });
      run.verify = undefined; run.uat = undefined;
      run.workflow.generation++;
      run.workflow.entry = 'build';
      current.deliveryPending = false;
      current.completedAt = undefined;
      current.uatRunId = undefined;
      current.lastError = undefined;
      current.failedAtState = undefined;
      current.state = IssueState.BranchCreated;
      current.currentPhase = 'build';
      current.orchestrationState = { kind: 'queued' };
    });
  }

}
