import { BasePhase, PhaseContext } from './BasePhase.js';
import { planModeVerifyPrompt, demandToPromptContext } from '../prompts/templates.js';
import { VerifyReportParser } from '../verify/index.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult } from '../orchestration/PhaseResult.js';

/**
 * 验证阶段 — 执行验证后根据报告判定通过/失败。
 *
 * - 报告通过 → CompletedIntent
 * - 报告未通过 → RequestRetryFromIntent('build')，让编排器走 verify-fix loop
 *
 * 验证阶段解析报告并返回阶段意图，由编排器执行有限修复循环。
 */
export class VerifyPhase extends BasePhase {
  readonly phaseName = 'verify' as const;
  private readonly reportParser = new VerifyReportParser();

  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const intent = await super.run(ctx, callbacks);
    if (intent.kind !== 'completed') return intent;

    const report = this.readVerifyReport();
    if (!report || ['Lint', 'Build', 'Test'].some(name => !new RegExp(name + '\\s*(?:结果|Result)\\*{0,2}\\s*[:：]\\s*(?:通过|失败|passed|failed|pass|fail|未通过)', 'i').test(report))) {
      return { kind: 'failed', sessionId: intent.sessionId, error: { message: '验证报告缺少本次 Lint、Build 或 Test 的明确结果，请人工检查执行环境', retryable: 'hard-no-auto' } };
    }

    const parsed = this.reportParser.parse(report);

    this.logger.info('Verify report parsed', {
      passed: parsed.passed,
      lintPassed: parsed.lintPassed,
      buildPassed: parsed.buildPassed,
      testPassed: parsed.testPassed,
      todolistComplete: parsed.todolistComplete,
      todolistStats: parsed.todolistStats,
      failureCount: parsed.failureReasons.length,
    });

    if (parsed.passed) return intent;

    if (!this.config.verifyFixLoop.enabled) {
      return {
        kind: 'failed',
        sessionId: intent.sessionId,
        error: {
          message: `验证失败，自动修复已关闭：${parsed.failureReasons.join('；')}`,
          rawOutput: parsed.rawReport,
          retryable: 'hard-no-auto',
        },
      };
    }

    return {
      kind: 'requestRetryFrom',
      targetPhaseId: 'build',
      reason: 'verify-failed',
      context: {
        verifyFailures: parsed.failureReasons,
        rawReport: parsed.rawReport,
        todolistStats: parsed.todolistStats,
      },
      sessionId: intent.sessionId,
    };
  }

  protected buildPrompt(ctx: PhaseContext): string {
    const pc = demandToPromptContext(ctx.demand);
    const promptCtx = {
      issueTitle: pc.title,
      issueDescription: pc.description,
      issueIid: Number(pc.displayId),
      workspace: ctx.workspace,
      knowledgeEnabled: this.config.knowledge.enabled,
    };
    return planModeVerifyPrompt(promptCtx);
  }

  private readVerifyReport(): string | null {
    const files = this.getResultFiles();
    if (files.length === 0) return null;
    return this.plan.readFile(files[0].filename);
  }

}
