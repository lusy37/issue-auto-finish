import { ISSUE_WORKFLOW_RECURSION_LIMIT } from '../dag/limits.js';
import { Command, END, START, StateGraph, StateSchema, interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { PhaseRunner, PhaseRunnerContext } from '../orchestration/PhaseRunner.js';
import type { PhaseError } from '../orchestration/PhaseResult.js';
import type { PhaseHistoryEntry } from '../orchestration/PhaseHistory.js';
import { PHASE_IDS, requiresWorkflowPhase, type PhaseId, type PhaseResultSummary, type ReviewDecision, type WorkflowNode } from '../orchestration/WorkflowState.js';
import { decodeReviewDecision } from '../orchestration/codecs/WorkflowCodec.js';
import { getPlanModePhases } from '../orchestration/Phases.js';
import type { IssueRecord } from '../tracker/IssueRecord.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import { renderPlan } from '../dag/contracts.js';
import { AsyncMutex } from '../utils/AsyncMutex.js';
import { IssueCheckpointer, workflowThreadId } from './IssueCheckpointer.js';
import { logger } from '../logger.js';
import { eventBus, type EventBus } from '../events/EventBus.js';
import { applyIssueLifecycleEvent } from '../tracker/IssueLifecycle.js';

// LangGraph 图内只保存“当前节点需要的最小状态”。IssueRecord 才是业务事实的持久化来源。
// entry 用于首次启动时指定入口；result/operation 用于节点之间传递阶段结果及其幂等键。
const State = new StateSchema({
  entry: z.enum([...PHASE_IDS, 'deliver']).default('plan'),
  result: z.custom<PhaseResultSummary | null>().default(null),
  operation: z.string().default(''),
});
const locks = new Map<string, AsyncMutex>();

export interface WorkflowOptions {
  tracker: IssueTracker;
  number: number;
  runner: PhaseRunner;
  context: PhaseRunnerContext;
  maxRetries: number;
  maxRepairs: number;
  signal?: AbortSignal;
  events?: Pick<EventBus, 'emitTyped'>;
  checkShutdown?: () => void;
  autoReview?: () => 'label' | 'configuration' | undefined;
  publish?: (phase: PhaseId, operation: string) => Promise<void>;
  deliver?: () => Promise<void>;
}

export class ReviewConflictError extends Error {}
class PhaseExecutionError extends Error {
  constructor(readonly phase: Exclude<PhaseId, 'review'>, readonly detail: PhaseError) { super(detail.message); }
}

/** 图是流程位置的唯一依据；聚合记录中的阶段状态用于业务凭证、展示和调度资格检查。 */
export class IssueWorkflow {
  readonly checkpointer: IssueCheckpointer;
  private readonly graph;
  private readonly config;
  private readonly lock: AsyncMutex;

  constructor(private readonly options: WorkflowOptions) {
    const record = this.record();
    // generation 参与线程 ID：手动回退或重新开始后会产生新线程，旧实例因此不能继续写入新流程。
    const threadId = workflowThreadId(options.number, record.run!.buildGeneration, record.run!.workflow.generation);
    this.checkpointer = new IssueCheckpointer(options.tracker.store, options.number, threadId);
    this.config = { configurable: { thread_id: threadId }, recursionLimit: ISSUE_WORKFLOW_RECURSION_LIMIT, durability: 'sync' as const };
    const key = options.tracker.store.file(options.number);
    this.lock = locks.get(key) ?? new AsyncMutex();
    locks.set(key, this.lock);
    // LangGraph 的 maxAttempts 包含首次执行，所以重试额度要加 1。
    // retryOn 不直接按“所有异常”重试，只接受带阶段信息的业务失败。
    const retryPolicy = { maxAttempts: options.maxRetries + 1, initialInterval: 10, maxInterval: 1000, retryOn: (error: unknown) => this.retry(error) };
    const phase = (id: Exclude<PhaseId, 'review'>) => (_state: typeof State.State, config: LangGraphRunnableConfig) => this.runPhase(id, config);
    const publish = (id: Exclude<PhaseId, 'review'>) => (state: typeof State.State) => this.publish(id, state);
    // 每个 AI 阶段后插入一个 publish 节点，把“阶段完成”与“同步产物”分开。
    // review 是 interrupt 节点；verify/uat 可以把流程回退到 build 做修复。
    this.graph = new StateGraph(State)
      .addNode('plan', phase('plan'), { retryPolicy, ends: ['publish_plan'] })
      .addNode('review', (_state, config) => this.review(config), { ends: ['plan', 'build'] })
      .addNode('build', phase('build'), { retryPolicy, ends: ['publish_build'] })
      .addNode('verify', phase('verify'), { retryPolicy, ends: ['publish_verify', 'build'] })
      .addNode('uat', phase('uat'), { retryPolicy, ends: ['publish_uat', 'build'] })
      .addNode('publish_plan', publish('plan'), { ends: ['review'] })
      .addNode('publish_build', publish('build'), { ends: ['verify'] })
      .addNode('publish_verify', publish('verify'), { ends: ['uat', 'deliver'] })
      .addNode('publish_uat', publish('uat'), { ends: ['deliver'] })
      .addNode('deliver', (_state, config) => this.deliver(config))
      .addConditionalEdges(START, state => state.entry, [...PHASE_IDS, 'deliver'])
      .addEdge('deliver', END)
      .compile({ checkpointer: this.checkpointer });
  }

  private record(): IssueRecord {
    const record = this.options.tracker.get(this.options.number);
    if (!record) throw new Error(`Issue #${this.options.number} 不存在`);
    return record;
  }
  private check(): void {
    this.options.signal?.throwIfAborted();
    this.options.checkShutdown?.();
    if (this.record().run!.stopIntent || this.options.tracker.store.isBlocked(this.options.number)) throw new Error('流程已停止或持久化不可写');
    const run = this.record().run!;
    // 旧实例可能仍在异步执行；每次读写前重新比较线程 ID，防止它覆盖新一轮流程。
    if (workflowThreadId(this.options.number, run.buildGeneration, run.workflow.generation) !== this.checkpointer.threadId) throw new Error('流程执行轮次已失效');
  }
  private update(update: (record: IssueRecord) => void): void {
    this.check();
    this.options.tracker.transaction(this.options.number, update);
  }
  private operation(phase: WorkflowNode, config: LangGraphRunnableConfig): string {
    return `${this.checkpointer.threadId}:${config.metadata?.langgraph_step}:${phase}`;
  }
  private history(record: IssueRecord, entry: Omit<PhaseHistoryEntry, 'planRevision' | 'buildGeneration'>): void {
    record.phaseHistory ??= [];
    record.phaseHistory.push({ ...entry, planRevision: record.run!.planRevision, buildGeneration: record.run!.buildGeneration });
  }

  async drive(): Promise<void> {
    await this.lock.runExclusive(async () => {
      this.check();
      const record = this.record();
      const lifecycle = record.lifecycle;
      // drive 既可能由轮询调用，也可能在恢复/重试后调用，因此必须先过滤终态和人工失败。
      if (['completed', 'cancelled', 'paused'].includes(lifecycle.kind)) return;
      if (lifecycle.kind === 'failed' && lifecycle.retry === 'manual') return;
      if (lifecycle.kind === 'failed') {
        const phase = lifecycle.phase;
        if (!phase || phase === 'review' || !PHASE_IDS.includes(phase as PhaseId)
          || !this.reserveRetry(phase as Exclude<PhaseId, 'review'>, true)) {
          this.update(current => {
            const failed = current.lifecycle;
            if (failed.kind !== 'failed') return;
            applyIssueLifecycleEvent(current, {
              type: 'phase-failed',
              phase: failed.phase,
              retry: 'manual',
              error: { ...failed.error, retryable: 'hard-no-auto' },
            });
          });
          return;
        }
      }
      // 有检查点时传 null，让 LangGraph 从保存的节点继续；没有检查点才使用业务入口。
      const saved = await this.checkpointer.getTuple(this.config);
      try {
        await this.graph.invoke(saved ? null : { entry: record.run!.workflow.entry }, { ...this.config, signal: this.options.signal });
        const snapshot = await this.graph.getState(this.config);
        // 只有框架已经持久化 interrupt，才把业务状态改成 waiting。
        // 若进程在 interrupt 写入前崩溃，重启时仍应按 running 恢复并重新落盘中断。
        const waiting = snapshot.tasks.flatMap(task => task.interrupts ?? []).some(item =>
          (item.value as { kind?: string; planRevision?: number })?.kind === 'review'
          && (item.value as { planRevision?: number }).planRevision === this.record().run!.planRevision);
        // 等待状态只在框架已保存审核中断后发布；此前崩溃仍按在途执行恢复。
        if (waiting) this.update(current => {
          applyIssueLifecycleEvent(current, { type: 'gate-interrupted', phase: 'review', planRevision: current.run!.planRevision });
          if (current.phaseProgress?.review) current.phaseProgress.review.status = 'gate_waiting';
        });
      } catch (error) {
        if (error instanceof PhaseExecutionError && !this.options.tracker.store.isBlocked(this.options.number)) {
          this.options.tracker.emitFailure(this.options.number);
          return;
        }
        throw error;
      }
    }, this.options.signal);
  }

  /** 审核接口只执行已挂起的审核节点，框架保存下一节点后返回；轮询继续其余阶段。 */
  async resumeReview(decision: ReviewDecision): Promise<void> {
    await this.lock.runExclusive(async () => {
      this.check();
      let parsed: ReviewDecision;
      try { parsed = decodeReviewDecision(decision); }
      catch { throw new ReviewConflictError('审核数据无效，驳回必须提供反馈'); }
      const record = this.record();
      if (record.run!.planRevision !== decision.planRevision || record.run!.review?.decision !== 'waiting') throw new ReviewConflictError('审核计划版本或状态已改变，请刷新页面');
      // 同时校验业务状态和图中断点：只满足其中一个，仍可能是过期请求或不完整恢复。
      const saved = await this.graph.getState(this.config);
      const pending = saved.tasks.flatMap(task => task.interrupts ?? []);
      if (!pending.some(item => (item.value as { kind?: string; planRevision?: number })?.kind === 'review' && (item.value as { planRevision?: number }).planRevision === decision.planRevision)) throw new ReviewConflictError('当前没有可恢复的审核中断，请刷新页面');
      // 审核接口只负责恢复 review；后续 build 由下一次 drive 负责，避免审核请求直接执行 AI。
      await this.graph.invoke(new Command({ resume: parsed }), { ...this.config, interruptAfter: ['review'] });
    });
  }

  getGraph() { return this.graph.getGraphAsync(); }
  getState() { return this.graph.getState(this.config); }
  getStateHistory() { return this.graph.getStateHistory(this.config); }

  private retry(error: unknown): boolean {
    return error instanceof PhaseExecutionError
      && this.reserveRetry(error.phase, error.detail.retryable !== 'hard-no-auto');
  }

  /**
   * retryUsed 不小于当前阶段执行次数表示预算已为下一次执行预留。retryPolicy 与崩溃恢复共用本函数，
   * 因而在“失败已保存”和“预算已预留”两个窗口退出都不会漏重试或重复扣减。
   */
  private reserveRetry(phase: Exclude<PhaseId, 'review'>, retryable: boolean): boolean {
    if (!retryable) return false;
    this.check();
    const record = this.record();
    const used = record.run!.retryUsed[phase] ?? 0;
    const executions = record.run!.phaseExecutions[phase] ?? 0;
    if (used >= executions && used > 0) return true;
    if (used >= this.options.maxRetries) return false;
    this.update(current => {
      const currentUsed = current.run!.retryUsed[phase] ?? 0;
      const currentExecutions = current.run!.phaseExecutions[phase] ?? 0;
      if (currentUsed < currentExecutions || currentUsed === 0) current.run!.retryUsed[phase] = currentUsed + 1;
    });
    return true;
  }

  private async runPhase(phase: Exclude<PhaseId, 'review'>, config: LangGraphRunnableConfig) {
    this.check();
    const operation = this.operation(phase, config);
    // 阶段结果和检查点分别落盘，二者之间可能崩溃；缓存结果用于恢复时跳过已完成的 AI 调用。
    const cached = this.record().run!.workflow.results[operation];
    if (cached) return this.phaseCommand(cached, operation);
    const startedAt = new Date().toISOString();
    // 先记录 in_progress 和执行次数，再调用外部 runner，便于崩溃后判断执行到了哪一步。
    this.update(record => {
      applyIssueLifecycleEvent(record, { type: 'phase-started', phase });
      record.phaseProgress ??= {};
      record.phaseProgress[phase] = { ...record.phaseProgress[phase], status: 'in_progress', startedAt, error: undefined, completedAt: undefined, sessionId: record.phaseProgress[phase]?.status === 'completed' ? undefined : record.phaseProgress[phase]?.sessionId };
      const executions = record.run!.phaseExecutions[phase] ?? 0;
      record.run!.phaseExecutions[phase] = executions + 1;
    });
    const run = this.record().run!;
    // 保存新计划会重置新版本预算，历史仍需引用当前这次实际执行。
    const attemptId = run.phaseExecutions[phase];
    const repair = run.repairs.at(-1);
    const spec = getPlanModePhases(true).find(spec => spec.id === phase)!;
    // runner 只返回阶段意图；它不决定图的下一节点，路由统一在本文件中完成。
    let intent = await this.options.runner.run(spec, {
      ...this.options.context, fixIteration: run.repairRounds,
      rawReport: phase === 'build' ? repair?.report : undefined,
      verifyFailures: phase === 'build' && repair ? [repair.report] : undefined,
    });
    this.check();
    // 只允许 completed、failed，或 verify/uat 请求回到 build；其他返回值视为不可恢复的集成错误。
    if (intent.kind !== 'failed' && intent.kind !== 'completed' && !(intent.kind === 'requestRetryFrom' && intent.targetPhaseId === 'build' && (phase === 'verify' || phase === 'uat') && this.record().run!.repairRounds < this.options.maxRepairs)) {
      intent = { kind: 'failed', error: { message: '阶段结果无效或集成修复额度已用完', retryable: 'hard-no-auto' }, sessionId: intent.sessionId };
    }
    if (intent.kind === 'failed') {
      this.update(record => {
        const retryUsed = record.run!.retryUsed[phase] ?? 0;
        const canAutoRetry = intent.error.retryable !== 'hard-no-auto' && retryUsed < this.options.maxRetries;
        applyIssueLifecycleEvent(record, {
          type: 'phase-failed',
          phase,
          retry: canAutoRetry ? 'auto' : 'manual',
          error: intent.error,
        });
        record.phaseProgress![phase] = { ...record.phaseProgress![phase], status: 'failed', error: intent.error.message };
        this.history(record, { phaseId: phase, attemptId, startedAt, endedAt: new Date().toISOString(), outcome: 'failed', sessionId: intent.sessionId, errorMessage: intent.error.message });
      });
      throw new PhaseExecutionError(phase, intent.error);
    }
    // 这是业务阶段结果的下一站；真正跳转还要经过对应的 publish 节点。
    const next: Record<Exclude<PhaseId, 'review'>, WorkflowNode> = {
      plan: 'review',
      build: 'verify',
      verify: requiresWorkflowPhase(this.record().run!.workflow, 'uat') ? 'uat' : 'deliver',
      uat: 'deliver',
    };
    let result: PhaseResultSummary;
    if (intent.kind === 'completed') result = { phase, outcome: 'completed', next: next[phase], sessionId: intent.sessionId };
    else if (intent.kind === 'requestRetryFrom' && intent.targetPhaseId === 'build' && (phase === 'verify' || phase === 'uat') && this.record().run!.repairRounds < this.options.maxRepairs) {
      result = { phase, outcome: 'retried-from', next: 'build', sessionId: intent.sessionId, report: typeof intent.context?.rawReport === 'string' ? intent.context.rawReport : intent.reason, failures: Array.isArray(intent.context?.verifyFailures) ? intent.context.verifyFailures.filter((v): v is string => typeof v === 'string') : [] };
    } else throw new PhaseExecutionError(phase, { message: '阶段结果无效或集成修复额度已用完', retryable: 'hard-no-auto' });
    // 结果、修复上下文、生命周期和历史必须在同一 Issue 事务中提交，覆盖检查点落盘前的崩溃窗口。
    this.update(record => {
      if (result.outcome === 'retried-from') {
        record.run!.buildEntry = 'repair-integration';
        record.run!.repairRounds++;
        record.run!.repairs.push({ round: record.run!.repairRounds, report: result.report ?? '', source: phase });
        record.run!.verify = undefined; record.run!.uat = undefined;
      }
      record.run!.workflow.results[operation] = result;
      if (result.next === 'deliver' && result.outcome === 'completed') {
        applyIssueLifecycleEvent(record, { type: 'delivery-started' });
        record.deliveryPending = true;
      } else {
        applyIssueLifecycleEvent(record, { type: 'phase-completed', phase });
      }
      record.phaseProgress![phase] = { ...record.phaseProgress![phase], status: result.outcome === 'completed' ? 'completed' : 'pending', completedAt: result.outcome === 'completed' ? new Date().toISOString() : undefined, sessionId: result.sessionId };
      this.history(record, { phaseId: phase, attemptId, startedAt, endedAt: new Date().toISOString(), outcome: result.outcome, sessionId: result.sessionId, ...(result.outcome === 'retried-from' ? { fixIteration: record.run!.repairRounds, errorMessage: result.report, retryFromContext: { verifyFailures: result.failures ?? [], rawReport: result.report ?? '' } } : {}) });
    });
    return this.phaseCommand(result, operation);
  }

  private phaseCommand(result: PhaseResultSummary, operation: string) {
    // completed 先去 publish；retried-from 直接回到 build，继续修复回路。
    return new Command({ update: { result, operation }, goto: result.outcome === 'completed' ? `publish_${result.phase}` : result.next });
  }
  private async publish(phase: PhaseId, state: typeof State.State) {
    this.check();
    if (!state.result) throw new Error('阶段节点没有提供执行结果');
    // effects 是发布副作用的幂等记录；阶段结果已存在不代表产物同步一定成功过。
    if (!this.record().run!.workflow.effects.includes(state.operation)) {
      // 产物同步是附加行为；操作编号传给平台适配层实现回写去重。
      try { await this.options.publish?.(phase, state.operation); }
      catch (error) { logger.warn('阶段产物同步失败', { phase, error: (error as Error).message }); }
      this.update(record => { record.run!.workflow.effects.push(state.operation); });
    }
    return new Command({ goto: state.result.next });
  }

  private review(config: LangGraphRunnableConfig) {
    this.check();
    const operation = this.operation('review', config);
    const cached = this.record().run!.workflow.results[operation];
    if (cached) return new Command({ update: { result: cached, operation }, goto: cached.next });
    const record = this.record();
    const revision = record.run!.planRevision;
    if (!revision || record.run!.review?.decision !== 'waiting') throw new ReviewConflictError('没有可审核的完整计划');
    const plan = this.options.tracker.store.readPlan(this.options.number, revision, record.run!.planDigest);
    const lifecycle = record.lifecycle;
    const wasWaiting = lifecycle.kind === 'waiting' && lifecycle.phase === 'review';
    const enteredReview = lifecycle.kind === 'running' && lifecycle.phase === 'review' && !!record.phaseProgress?.review?.startedAt;
    if (!enteredReview) this.update(current => {
      const currentLifecycle = current.lifecycle;
      const alreadyWaiting = currentLifecycle.kind === 'waiting' && currentLifecycle.phase === 'review';
      if (!alreadyWaiting && (currentLifecycle.kind !== 'running' || currentLifecycle.phase !== 'review')) {
        applyIssueLifecycleEvent(current, { type: 'phase-started', phase: 'review' });
      }
      current.phaseProgress ??= {};
      current.phaseProgress.review = { status: 'in_progress', startedAt: current.phaseProgress.review?.startedAt ?? new Date().toISOString() };
    });
    // 已进入审核后恢复时必须使用中断决定，不能因配置变化绕过人工审核。
    // 一旦已经进入人工审核，就不能因配置在运行中变化而偷偷改成自动批准。
    const source = wasWaiting || enteredReview ? undefined : this.options.autoReview?.();
    const decision = decodeReviewDecision(source ? { action: 'approve', source, planRevision: revision } : interrupt({ kind: 'review', issueNumber: this.options.number, planRevision: revision, planDigest: plan.digest }));
    const result: PhaseResultSummary = { phase: 'review', outcome: decision.action === 'approve' ? 'gate-approved' : 'gate-rejected', next: decision.action === 'approve' ? 'build' : 'plan' };
    // 审核决定与计划版本一起校验并提交，防止旧页面对新计划进行批准/驳回。
    this.update(current => {
      const run = current.run!;
      if (decision.planRevision !== run.planRevision || run.review?.decision !== 'waiting') throw new ReviewConflictError('审核计划版本或状态已改变');
      run.review = { revision, decision: decision.action === 'approve' ? 'approved' : 'rejected', feedback: decision.feedback, source: decision.source ?? 'manual' };
      if (decision.action === 'reject') {
        // 驳回必须保留当时的完整计划快照；重新规划后仍可回顾用户针对哪一版提出反馈。
        run.reviewHistory ??= [];
        run.reviewHistory.push({ round: run.reviewHistory.length + 1, revision, feedback: decision.feedback!, timestamp: new Date().toISOString(), planSnapshot: renderPlan(plan), reviewedSessionId: current.phaseProgress?.plan?.sessionId });
        for (const progress of Object.values(current.phaseProgress ?? {})) Object.assign(progress, { status: 'pending', startedAt: undefined, completedAt: undefined });
      }
      applyIssueLifecycleEvent(current, { type: 'gate-resolved', phase: 'review', action: decision.action, planRevision: revision });
      current.phaseProgress!.review = { ...current.phaseProgress!.review, status: decision.action === 'approve' ? 'completed' : 'pending', completedAt: new Date().toISOString() };
      run.workflow.results[operation] = result;
      this.history(current, { phaseId: 'review', attemptId: 1, startedAt: current.phaseProgress!.review.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString(), outcome: result.outcome, approvalSource: decision.source ?? 'manual' });
    });
    (this.options.events ?? eventBus).emitTyped(decision.action === 'approve' ? 'gate:approved' : 'gate:rejected', { issueIid: this.options.number, phaseId: 'review', feedback: decision.feedback, source: decision.source ?? 'manual' });
    return new Command({ update: { result, operation }, goto: result.next });
  }

  private async deliver(config: LangGraphRunnableConfig) {
    this.check();
    const operation = this.operation('deliver', config);
    // 交付可能在执行成功后、检查点写入前崩溃；缓存命中时不要重复创建外部交付物。
    if (this.record().run!.workflow.results[operation]) return {};
    if (!this.options.deliver) throw new Error('交付执行器未配置');
    await this.options.deliver();
    this.update(record => { record.run!.workflow.results[operation] = { phase: 'deliver', outcome: 'completed', next: END }; });
    return {};
  }
}
