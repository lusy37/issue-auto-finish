import { BasePhase, PhaseContext } from './BasePhase.js';
import { planModeVerifyPrompt, demandToPromptContext } from '../prompts/templates.js';
import {
  VERIFY_AGENT_OUTPUT_SCHEMA,
  evaluateVerifyResult,
  parseVerifyAgentOutput,
} from '../verify/VerifyResultCodec.js';
import { ARTIFACTS } from '../shared/runtime/artifacts.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult } from '../orchestration/PhaseResult.js';
import type { JsonSchema } from '../ai-runner/index.js';

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

  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const intent = await super.run(ctx, callbacks);
    if (intent.kind !== 'completed') return intent;

    const parsed = parseVerifyAgentOutput(intent.output);
    const evaluation = evaluateVerifyResult(parsed);

    this.logger.info('Verify report parsed', {
      passed: evaluation.passed,
      lintPassed: parsed.checks.lint.status === 'passed',
      buildPassed: parsed.checks.build.status === 'passed',
      testPassed: parsed.checks.test.status === 'passed',
      failureCount: evaluation.failureReasons.length,
    });

    if (evaluation.passed) return intent;

    if (!this.config.verifyFixLoop.enabled) {
      return {
        kind: 'failed',
        sessionId: intent.sessionId,
        error: {
          message: `验证失败，自动修复已关闭：${evaluation.failureReasons.join('；')}`,
          rawOutput: parsed.reportMarkdown,
          retryable: 'hard-no-auto',
        },
      };
    }

    return {
      kind: 'requestRetryFrom',
      targetPhaseId: 'build',
      reason: 'verify-failed',
      context: {
        verifyFailures: evaluation.failureReasons,
        rawReport: parsed.reportMarkdown,
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

  protected getOutputSchema(): JsonSchema {
    return VERIFY_AGENT_OUTPUT_SCHEMA;
  }

  protected prepareAgentOutput(output: string): void {
    const parsed = parseVerifyAgentOutput(output);
    this.plan.writeFile(ARTIFACTS.verifyReport.filename, parsed.reportMarkdown);
  }
}
