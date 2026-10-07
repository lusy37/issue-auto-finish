import { BasePhase, PhaseContext } from './BasePhase.js';
import { planModeVerifyPrompt, demandToPromptContext, getKnowledgeForPrompt } from '../prompts/templates.js';
import { runVerificationCommands, renderVerificationEvidence, type VerificationChecks } from '../verify/VerificationCommands.js';
import {
  VERIFY_AGENT_OUTPUT_SCHEMA,
  evaluateVerifyResult,
  parseVerifyAgentOutput,
  type VerifyAgentResult,
} from '../verify/VerifyResultCodec.js';
import { ARTIFACTS } from '../shared/runtime/artifacts.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult } from '../orchestration/PhaseResult.js';
import type { JsonSchema } from '../ai-runner/index.js';

/**
 * 验证阶段 — 工作台执行命令，只读 AI 分析结果，真实退出码决定通过/失败。
 *
 * - 报告通过 → CompletedIntent
 * - 报告未通过 → RequestRetryFromIntent('build')，让编排器走 verify-fix loop
 *
 * 验证阶段解析报告并返回阶段意图，由编排器执行有限修复循环。
 */
export class VerifyPhase extends BasePhase {
  readonly phaseName = 'verify' as const;
  private parsedOutput?: VerifyAgentResult;
  private commandChecks?: VerificationChecks;

  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    this.parsedOutput = undefined;
    this.commandChecks = undefined;
    try {
      this.plan.writeFile(ARTIFACTS.verifyReport.filename, '# 验证报告\n\n本轮验证正在执行，尚未形成通过凭证。');
      const kv = getKnowledgeForPrompt(this.config.knowledge.enabled);
      this.commandChecks = await runVerificationCommands({
        workDir: this.plan.baseDir,
        git: this.git,
        timeoutMs: this.config.ai.phaseTimeoutMs,
        commands: { lint: kv.lintCommand, build: kv.buildCommand, test: kv.testCommand },
        onOutput: text => callbacks?.onStreamEvent?.({
          type: 'verify.command', content: text, timestamp: new Date().toISOString(),
        }),
      });
      this.plan.writeFile(
        ARTIFACTS.verifyReport.filename, renderVerificationEvidence(this.commandChecks),
      );
    } catch (error) {
      this.plan.writeFile(
        ARTIFACTS.verifyReport.filename, `# 验证报告\n\n本轮验证已停止：${(error as Error).message}`,
      );
      return { kind: 'failed', error: { message: (error as Error).message, retryable: 'hard-no-auto' } };
    }
    const intent = await super.run(ctx, callbacks);
    if (intent.kind !== 'completed') return intent;

    const parsed = this.parsedOutput!;
    const evaluation = evaluateVerifyResult(parsed);

    this.logger.info('Verify report parsed', {
      passed: evaluation.passed,
      lintPassed: parsed.checks.lint.status === 'passed',
      buildPassed: parsed.checks.build.status === 'passed',
      testPassed: parsed.checks.test.status === 'passed',
      failureCount: evaluation.failureReasons.length,
    });

    if (evaluation.passed) return { ...intent, output: JSON.stringify(parsed) };

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
    return planModeVerifyPrompt(promptCtx) + '\n\n本轮工作台执行结果（唯一检查凭证）：\n' +
      JSON.stringify(this.commandChecks);
  }

  /** 每轮验证当前代码，不能恢复旧会话并沿用失败结论。 */
  protected resolveResumeInfo(): { resumable: boolean } {
    return { resumable: false };
  }

  protected getOutputSchema(): JsonSchema {
    return VERIFY_AGENT_OUTPUT_SCHEMA;
  }

  protected prepareAgentOutput(output: string): void {
    const parsed = parseVerifyAgentOutput(output);
    for (const name of ['lint', 'build', 'test'] as const) {
      const actual = this.commandChecks![name];
      const reported = parsed.checks[name];
      if (reported.command !== actual.command ||
        reported.exitCode !== actual.exitCode || reported.status !== actual.status) {
        throw new Error(`VERIFY 报告的 ${name} 结果与本轮命令执行凭证不一致`);
      }
    }
    // 状态和诊断来自进程结果，模型只补充解释。
    parsed.checks = this.commandChecks!;
    parsed.reportMarkdown += '\n\n' + renderVerificationEvidence(this.commandChecks!);
    this.parsedOutput = parsed;
    this.plan.writeFile(ARTIFACTS.verifyReport.filename, parsed.reportMarkdown);
  }
}
