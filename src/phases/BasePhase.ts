import { buildCallOptions, configuredCallPolicy } from '../ai-runner/CallPolicy.js';
import { parseJsonOutput } from '../prompts/parseJsonOutput.js';
import { resolvePromptRules } from '../knowledge/PromptRules.js';
import { getPhaseArtifacts } from '../shared/runtime/artifacts.js';
import { renderPlan, type PlanContent } from '../dag/contracts.js';
import { decodePlanContent } from '../dag/codecs/TaskPlanCodec.js';
import type { AIRunner, JsonSchema, RunResult, StreamEvent } from '../ai-runner/index.js';

import { GitOperations } from '../git/GitOperations.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';

import { Config } from '../config.js';

import type { PortPair } from '../preview/PortAllocator.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { WorkspaceLayout } from '../prompts/templates.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseSessionStore } from './PhaseSessionStore.js';
import type { PhaseResult, PhaseError, ArtifactRef } from '../orchestration/PhaseResult.js';
import { logger as rootLogger, Logger } from '../logger.js';
import { t } from '../i18n/index.js';

/** 将计数按降序格式化为 "k1×n1, k2×n2"；空映射返回 undefined。 */
function formatCountsByDesc(counts: Map<string, number>): string | undefined {
  if (counts.size === 0) return undefined;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return entries.map(([k, v]) => `${k}×${v}`).join(', ');
}

export interface PhaseContext {
  onTemporaryFile?: (file: string, present: boolean) => void;
  demand: DemandSpec;
  branchName: string;
  pipelineMode?: string;
  ports?: PortPair;
  workspace?: WorkspaceLayout;
  workDir?: string;
}

/**
 * 阶段抽象基类 — 纯逻辑执行，零编排副作用。
 *
 * 阶段约定：
 * - run() 返回 PhaseResult（completed / failed / requestRetryFrom）。
 * - 阶段内部不推进生命周期，也不触发 eventBus / git commit / GitHub 评论；
 *   这些副作用由编排器根据返回的 Intent 驱动。
 * - 阶段只通过 PlanPersistence 读写产物；执行会话凭证通过窄存储端口持久化。
 *
 * 失败 → Intent 映射：
 * - 产物校验失败（无变更/缺产物）→ retryable='hard-no-auto'（自动重试无意义，需用户介入）
 * - AI 超时但仍在活跃输出 → retryable='soft'（同样消耗有限重试预算）
 * - AI 永久失败（auth/quota/model 不存在）→ retryable='hard-no-auto'
 * - 其他 AI 失败 → retryable='hard'
 */
export abstract class BasePhase {
  static readonly MIN_ARTIFACT_BYTES = 50;

  protected aiRunner: AIRunner;
  protected git: GitOperations;
  protected plan: PlanPersistence;
  protected config: Config;
  protected sessionStore?: PhaseSessionStore;
  protected logger: Logger;
  private lastStreamSummary?: {
    eventTypeCounts: Map<string, number>;
  };

  abstract readonly phaseName: string;

  constructor(
    aiRunner: AIRunner,
    git: GitOperations,
    plan: PlanPersistence,
    config: Config,
    sessionStore?: PhaseSessionStore,
  ) {
    this.aiRunner = aiRunner;
    this.git = git;
    this.plan = plan;
    this.config = config;
    this.sessionStore = sessionStore;
    this.logger = rootLogger.child(this.constructor.name);
  }

  /** 阶段校验与发布使用同一份产物定义。 */
  getResultFiles(_ctx?: PhaseContext): Array<{ filename: string; label: string }> {
    return getPhaseArtifacts(this.phaseName).map(({ filename, label }) => ({ filename, label }));
  }

  /**
   * 执行阶段并返回意图 — 纯逻辑，零编排副作用。
   *
   * VerifyPhase 可返回 requestRetryFrom 请求集成修复。默认成功返回 completed，失败返回 failed。
   */
  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const displayId = Number(ctx.demand.sourceRef.displayId);
    const expectedResultFiles = this.getResultFiles(ctx);

    this.lastStreamSummary = {
      eventTypeCounts: new Map(),
    };

    let prompt = this.buildPrompt(ctx);
    const rules = await this.resolveRules(ctx);
    if (rules) prompt += `\n\n${t('basePhase.rulesSection', { rules })}`;

    const resumeInfo = this.resolveResumeInfo(displayId);
    let result: RunResult;

    if (resumeInfo.resumable) {
      this.logger.info('Attempting session resume', {
        issueIid: displayId,
        phase: this.phaseName,
        sessionId: resumeInfo.sessionId,
      });
      result = await this.runAI(
        displayId,
        this.getResumePrompt(ctx) + (rules ? `\n\n${t('basePhase.rulesSection', { rules })}` : ''),
        { sessionId: resumeInfo.sessionId!, continueSession: true },
        callbacks?.onStreamEvent,
      );
    } else {
      result = await this.runAI(displayId, prompt, undefined, callbacks?.onStreamEvent);
    }

    if (!result.success) {
      const error = this.classifyFailure(result);
      return { kind: 'failed', error, sessionId: result.sessionId };
    }

    let planContent: PlanContent | undefined;
    if (this.phaseName === 'plan') {
      if (result.output.trim().length < BasePhase.MIN_ARTIFACT_BYTES)
        return {
          kind: 'failed',
          error: { message: '计划内容为空或不完整', retryable: 'hard-no-auto' },
        };
      try {
        planContent = decodePlanContent(parseJsonOutput(result.output));
      } catch (error) {
        return {
          kind: 'failed',
          error: { message: `结构化计划无效：${(error as Error).message}`, retryable: 'hard' },
        };
      }
    }
    try {
      // 阶段可以在这里把结构化 Agent 结果转换为展示产物；状态判断仍由阶段自身完成。
      this.prepareAgentOutput(result.output);
      if (planContent) {
        // 计划展示产物由编排器统一落盘，阶段只校验本次内容，不依赖旧文件。
        if (Buffer.byteLength(renderPlan(planContent), 'utf-8') < BasePhase.MIN_ARTIFACT_BYTES)
          throw new Error('计划内容为空或不完整');
      } else {
        await this.validatePhaseOutput(ctx, displayId, expectedResultFiles);
      }
    } catch (err) {
      const message = (err as Error).message;
      return {
        kind: 'failed',
        error: { message, retryable: 'hard-no-auto', rawOutput: result.output },
        sessionId: result.sessionId,
      };
    }

    return {
      kind: 'completed',
      output: result.output,
      ...(planContent ? { planContent } : {}),
      sessionId: result.sessionId,
      artifacts: this.toArtifactRefs(expectedResultFiles),
    };
  }

  protected abstract buildPrompt(ctx: PhaseContext): string;

  /**
   * 返回给 Codex SDK 的最终响应 JSON Schema。
   * 普通阶段可以保持 undefined；需要驱动状态转移的阶段应覆盖它。
   */
  protected getOutputSchema(): JsonSchema | undefined {
    return undefined;
  }

  /**
   * 将 Agent 的结构化响应物化为展示产物。
   * 该钩子在产物完整性校验前执行，解析失败会阻止阶段继续推进。
   */
  protected prepareAgentOutput(_output: string): void {
    // 默认阶段没有服务端展示产物。
  }

  protected getResumePrompt(_ctx: PhaseContext): string {
    return t('basePhase.resumePrompt');
  }

  protected resolveResumeInfo(issueIid: number): { resumable: boolean; sessionId?: string } {
    const progress = this.sessionStore?.getPhaseProgress(issueIid, this.phaseName);
    const previousSessionId = progress?.sessionId;
    if (!previousSessionId || this.aiRunner.canResumeSession?.(previousSessionId) === false) {
      return { resumable: false };
    }
    const phaseStatus = progress?.status;
    if (phaseStatus !== 'failed' && phaseStatus !== 'in_progress') {
      return { resumable: false };
    }
    return { resumable: true, sessionId: previousSessionId };
  }

  protected async runAI(
    issueIid: number,
    prompt: string,
    options?: { sessionId?: string; continueSession?: boolean },
    onStreamEvent?: (event: StreamEvent) => void,
  ): Promise<RunResult> {
    let capturedSessionId: string | undefined;
    const result = await this.aiRunner.run({
      prompt,
      workDir: this.plan.baseDir,
      ...buildCallOptions(
        configuredCallPolicy(this.config.ai),
        this.phaseName === 'plan' ? 'plan' : 'verify',
      ),
      outputSchema: this.getOutputSchema(),
      phaseName: this.phaseName,
      sessionId: options?.sessionId,
      continueSession: options?.continueSession,
      onStreamEvent: (event) => {
        this.captureStreamSummary(event);
        if (!capturedSessionId && event.sessionId) {
          capturedSessionId = event.sessionId;
          this.persistSessionId(issueIid, capturedSessionId);
        }
        onStreamEvent?.(event);
      },
    });
    if (result.sessionId) {
      this.persistSessionId(issueIid, result.sessionId);
    }
    return result;
  }

  /** 把 Runner 已提供的结构化超时状态翻译成阶段错误。 */
  protected classifyFailure(result: RunResult): PhaseError {
    const message = (result.errorMessage || result.output).slice(0, 500);
    const rawOutput = result.output;

    if (result.wasActiveAtTimeout) {
      return { message, retryable: 'soft', rawOutput };
    }

    return { message, retryable: 'hard', rawOutput };
  }

  protected persistSessionId(issueIid: number, sessionId: string | undefined): void {
    if (sessionId) this.sessionStore?.updatePhaseProgress(issueIid, this.phaseName, { sessionId });
  }

  protected toArtifactRefs(
    files: ReadonlyArray<{ filename: string; label: string }>,
  ): readonly ArtifactRef[] {
    return files.map((f) => ({ filename: f.filename, label: f.label }));
  }
  protected async resolveRules(_ctx: PhaseContext): Promise<string | null> {
    return resolvePromptRules(this.config.knowledge.enabled);
  }

  protected async validatePhaseOutput(
    ctx: PhaseContext,
    _displayId: number,
    resultFiles = this.getResultFiles(ctx),
  ): Promise<void> {
    if (resultFiles.length === 0) return;

    const missing: string[] = [];

    for (const file of resultFiles) {
      if (!this.plan.isArtifactReady(file.filename, BasePhase.MIN_ARTIFACT_BYTES)) {
        const content = this.plan.readFile(file.filename);
        if (content === null) {
          missing.push(file.filename);
        } else {
          missing.push(`${file.filename} (${Buffer.byteLength(content, 'utf-8')} bytes, 内容不足)`);
        }
      }
    }

    if (missing.length > 0) {
      const lines = [`AI 进程成功退出但未生成预期产物: ${missing.join(', ')}`];
      const hint = this.formatStreamSummaryHint();
      if (hint) lines.push(`  → ${hint}`);
      const msg = lines.join('\n');
      this.logger.error(msg, { phase: this.phaseName, displayId: _displayId });
      throw new Error(msg);
    }
  }

  private captureStreamSummary(event: StreamEvent): void {
    const summary = this.lastStreamSummary;
    if (!summary) return;
    const type = event.type;
    summary.eventTypeCounts.set(type, (summary.eventTypeCounts.get(type) ?? 0) + 1);
  }

  private formatStreamSummaryHint(): string | undefined {
    const summary = this.lastStreamSummary;
    if (!summary) return undefined;
    const events = formatCountsByDesc(summary.eventTypeCounts);
    return events ? `流式事件: ${events}` : undefined;
  }
}
