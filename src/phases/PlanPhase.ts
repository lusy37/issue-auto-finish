import { MAX_PLAN_TASKS } from '../dag/limits.js';
import { BasePhase, PhaseContext } from './BasePhase.js';
import {
  planPrompt,
  rePlanPrompt,
  demandToPromptContext,
  buildReviewFeedbackResumePrompt,
} from '../prompts/templates.js';
import { supportsPlanModeResume } from '../ai-runner/index.js';

/** 计划与驳回重规划均返回结构化只读结果；SDK 会话恢复也显式携带完整上版计划与反馈。 */
export class PlanPhase extends BasePhase {
  readonly phaseName = 'plan' as const;

  protected buildPrompt(ctx: PhaseContext): string {
    const pc = demandToPromptContext(ctx.demand);
    const history = this.plan.readReviewHistory();
    const promptCtx = {
      issueTitle: pc.title,
      issueDescription: pc.description,
      issueIid: Number(pc.displayId),
      supplementText: pc.supplementText || undefined,
      workspace: ctx.workspace,
    };

    let basePrompt: string;
    if (history.length > 0) {
      basePrompt = rePlanPrompt(promptCtx, history);
    } else {
      basePrompt = planPrompt(promptCtx);
    }

    return basePrompt + this.structuredContract();
  }

  /** 优先恢复合法 SDK 会话；恢复失败时使用完整重规划提示词重新调用。 */
  protected resolveResumeInfo(issueIid: number): { resumable: boolean; sessionId?: string } {
    const standard = super.resolveResumeInfo(issueIid);
    if (standard.resumable) return standard;

    if (!supportsPlanModeResume(this.config.ai.mode)) {
      return { resumable: false };
    }
    const history = this.plan.readReviewHistory();
    if (history.length === 0) return { resumable: false };
    const latest = history[history.length - 1];
    if (
      !latest.reviewedSessionId ||
      this.aiRunner.canResumeSession?.(latest.reviewedSessionId) === false
    ) {
      return { resumable: false };
    }

    this.logger.info('Reject-replan resume candidate detected', {
      phase: this.phaseName,
      sessionId: latest.reviewedSessionId,
      historyCount: history.length,
    });
    return { resumable: true, sessionId: latest.reviewedSessionId };
  }

  /** 不依赖会话记忆保存审核依据，每次均传入本轮反馈、补充资料及完整旧计划。 */
  protected getResumePrompt(ctx: PhaseContext): string {
    const history = this.plan.readReviewHistory();
    if (history.length === 0) return super.getResumePrompt(ctx) + this.structuredContract();
    const pc = demandToPromptContext(ctx.demand);
    return (
      buildReviewFeedbackResumePrompt(history, pc.supplementText || undefined) +
      this.structuredContract()
    );
  }
  private structuredContract(): string {
    return `\n最终只返回严格 JSON，不写文件，不返回 Markdown 计划。结构：{"title":"父需求标题","description":"完整实施说明","acceptanceCriteria":["父需求验收标准"],"tasks":[{"id":"task1","title":"任务标题","instructions":"完整实现要求","acceptanceCriteria":["任务验收标准"],"dependsOn":[]}]}。1～${MAX_PLAN_TASKS} 个任务；依赖只使用已定义 ID，不能成环；目录及分支由服务端决定。所有任务共同完成一个父 Issue，最后统一验收和交付。`;
  }
}
