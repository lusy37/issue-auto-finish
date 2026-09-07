import type { GitHubClient } from '../clients/GitHubClient.js';
import type { GitOperations } from '../git/GitOperations.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { EventBus } from '../events/EventBus.js';
import type { BasePhase } from '../phases/BasePhase.js';
import type {
  ReducerSideEffect,
  SideEffectExecutor,
} from '../orchestration/index.js';
import { logger as rootLogger } from '../logger.js';
import { commitPlanFiles, syncResultToIssue } from './steps/PhaseHelpers.js';
import { issueProgressComment } from '../prompts/templates.js';
import type { IssueProcessingContext, OrchestratorDeps } from './IssueProcessingContext.js';

/**
 * 默认副作用执行器 — 把 ReducerSideEffect 翻译为对外部组件的具体调用。
 *
 * 委托给以下子系统：
 * - commit-artifacts          → wtGit (git add/commit/push)
 * - sync-result-to-issue      → GitHubClient.createIssueNote + 产物同步
 * - emit-event                → EventBus
 * - comment-progress          → GitHubClient.createIssueNote
 * - await-async               → 记录等待日志，由 Orchestrator 等待结果
 */
export class DefaultSideEffectExecutor implements SideEffectExecutor {
  private readonly logger = rootLogger.child('DefaultSideEffectExecutor');

  private readonly issueCtx: IssueProcessingContext;
  private readonly deps: OrchestratorDeps;
  private readonly github: GitHubClient;
  private readonly eventBus: EventBus;
  private readonly wtGit: GitOperations;
  private readonly wtPlan: PlanPersistence;
  private readonly phaseFactory: (phaseId: string) => BasePhase;

  constructor(args: {
    issueCtx: IssueProcessingContext;
    deps: OrchestratorDeps;
    wtGit: GitOperations;
    wtPlan: PlanPersistence;
    phaseFactory: (phaseId: string) => BasePhase;
  }) {
    this.issueCtx = args.issueCtx;
    this.deps = args.deps;
    this.github = args.deps.github;
    this.eventBus = args.deps.eventBus;
    this.wtGit = args.wtGit;
    this.wtPlan = args.wtPlan;
    this.phaseFactory = args.phaseFactory;
  }

  async execute(number: number, _phaseId: string, effect: ReducerSideEffect): Promise<void> {
    switch (effect.kind) {
      case 'commit-artifacts':
        await this.commitArtifacts(effect.phaseId);
        break;
      case 'sync-result-to-issue':
        await this.syncResult(effect.phaseId);
        break;
      case 'emit-event':
        this.emitEvent(number, effect.type, effect.payload);
        break;
      case 'comment-progress':
        await this.commentProgress(effect.phaseId, effect.message);
        break;
      case 'await-async':
        this.eventBus.emitTyped('agent:output', {
          issueIid: number,
          phase: effect.phaseId,
          event: {
            type: 'system',
            content: 'phase awaiting async result',
            timestamp: new Date().toISOString(),
          },
        });
        break;
    }
  }

  private async commitArtifacts(phaseId: string): Promise<void> {
    try {
      const phaseCtx = this.issueCtx.phaseCtx;
      await commitPlanFiles(
        phaseCtx,
        this.wtGit,
        phaseId,
        this.issueCtx.issue.number,
      );
    } catch (err) {
      this.logger.warn('commit-artifacts failed', { phaseId, error: (err as Error).message });
    }
  }

  private async syncResult(phaseId: string): Promise<void> {
    try {
      const phase = this.phaseFactory(phaseId);
      const phaseCtx = this.issueCtx.phaseCtx;
      await syncResultToIssue(
        phase,
        phaseCtx,
        this.issueCtx.issue.number,
        phaseId,
        this.deps,
        this.issueCtx.issue.number,
        this.wtPlan,
      );
    } catch (err) {
      this.logger.warn('sync-result-to-issue failed', { phaseId, error: (err as Error).message });
    }
  }

  private emitEvent(number: number, type: string, payload: Record<string, unknown>): void {
    this.eventBus.emitTyped(type as never, { issueIid: number, ...payload });
  }

  private async commentProgress(phaseId: string, message: string): Promise<void> {
    try {
      const issueId = this.issueCtx.issue.number;
      await this.github.createIssueNote(
        issueId,
        message || issueProgressComment(phaseId, 'in_progress'),
      );
    } catch (err) {
      this.logger.warn('comment-progress failed', { phaseId, error: (err as Error).message });
    }
  }

}
