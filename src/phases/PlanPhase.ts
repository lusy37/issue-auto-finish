import { BasePhase, PhaseContext } from './BasePhase.js';
import {
  planPrompt,
  rePlanPrompt,
  demandToPromptContext,
  buildReviewFeedbackResumePrompt,
} from '../prompts/templates.js';
import {
  supportsPlanModeResume,
} from '../ai-runner/index.js';

/**
 * plan 阶段。除标准 plan/rePlan prompt 构造外,还负责 reject-replan 的会话续聊路径:
 *
 *   1. 优先 `--resume <sessionId>`(原生续聊): 当 runner 支持 plan resume
 *      (`capabilities.planModeResumable=true`)且 review-history.json 中存有
 *      上一轮 plan 的 `reviewedSessionId` 时启用。AI 在原 session memory 中
 *      已经记得原方案,只需发反馈即可做对照式修订。
 *   2. fallback 全文注入: runner 不支持 resume / sessionId 缺失 / resume 实际
 *      执行失败时,自动退回到完整 `rePlanPrompt`(包含 `<rejected-plan>` 全文)。
 *
 * 两条路径由 `BasePhase.runWithResumeFallback` 统一调度——resume 路径异常时,
 * 第二次以 fullPrompt(`buildPrompt(ctx)` 产物)重发,无需调用方关心切换。
 */
export class PlanPhase extends BasePhase {
  readonly phaseName = 'plan' as const;

  getResultFiles() {
    return [{ filename: '01-plan.md', label: '实施计划' }];
  }

  protected getRunMode(): 'plan' | 'agent' | undefined {
    return 'plan';
  }

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

  /**
   * reject-replan 优先用 `--resume` 续聊原 plan session:
   *   - 父类 resolveResumeInfo 命中(failed/in_progress)→ 标准恢复路径,直接返回
   *   - 否则:有 review history + 最近一轮带 reviewedSessionId + runner 支持
   *     plan resume → 走 reject-replan 续聊
   *
   * 任一条件不满足都返回 not resumable,走 BasePhase 的全新执行路径
   * (此时 buildPrompt 返回的 rePlanPrompt 已经在 deterministicCopy 路径注入
   *  `<rejected-plan>` 全文,功能正确性不依赖 resume)。
   */
  protected resolveResumeInfo(): { resumable: boolean; sessionId?: string } {
    const standard = super.resolveResumeInfo();
    if (standard.resumable) return standard;

    if (!supportsPlanModeResume(this.config.ai.mode)) {
      return { resumable: false };
    }
    const history = this.plan.readReviewHistory();
    if (history.length === 0) return { resumable: false };
    const latest = history[history.length - 1];
    if (!latest.reviewedSessionId || this.aiRunner.canResumeSession?.(latest.reviewedSessionId) === false) {
      return { resumable: false };
    }

    this.logger.info('Reject-replan resume candidate detected', {
      phase: this.phaseName,
      sessionId: latest.reviewedSessionId,
      historyCount: history.length,
    });
    return { resumable: true, sessionId: latest.reviewedSessionId };
  }

  /**
   * 当走 reject-replan resume 时,续聊 prompt 改为"基于审核反馈+补充信息做实质
   * 修改"(无需注入旧方案,session memory 已含;但 supplement 是用户驳回后追加的
   * 上下文,session memory 不一定包含,需显式注入);否则沿用 BasePhase 默认的
   * "继续中断的执行"通用 prompt。
   */
  protected getResumePrompt(ctx: PhaseContext): string {
    const history = this.plan.readReviewHistory();
    if (history.length === 0) return super.getResumePrompt(ctx) + this.structuredContract();
    const pc = demandToPromptContext(ctx.demand);
    return buildReviewFeedbackResumePrompt(history, pc.supplementText || undefined) + this.structuredContract();
  }
  private structuredContract(): string {
    return '\n最终只返回严格 JSON，不写文件，不返回 Markdown 计划。结构：{"title":"父需求标题","description":"完整实施说明","acceptanceCriteria":["父需求验收标准"],"tasks":[{"id":"task1","title":"任务标题","instructions":"完整实现要求","acceptanceCriteria":["任务验收标准"],"dependsOn":[]}]}。1～20 个任务；依赖只使用已定义 ID，不能成环；目录及分支由服务端决定。所有任务共同完成一个父 Issue，最后统一验收和交付。';
  }

}
