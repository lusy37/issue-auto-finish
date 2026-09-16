import { resolvePromptRules } from '../knowledge/PromptRules.js';
import { renderPlan } from '../dag/contracts.js';
import { decodePlanContent } from '../dag/codecs/TaskPlanCodec.js';
import type { AIRunner, RunResult, StreamEvent } from '../ai-runner/index.js';

import { GitOperations } from '../git/GitOperations.js';
import { PlanPersistence } from '../persistence/PlanPersistence.js';

import { Config } from '../config.js';

import type { PortPair } from '../preview/PortAllocator.js';
import type { DemandSpec } from '../demand/DemandSpec.js';
import type { WorkspaceLayout } from '../prompts/templates.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult, PhaseError, ArtifactRef } from '../orchestration/PhaseResult.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import { logger as rootLogger, Logger } from '../logger.js';
import { t } from '../i18n/index.js';

/** Format a {key→count} map as "k1×n1, k2×n2" sorted by count desc; returns undefined when empty. */
function formatCountsByDesc(counts: Map<string, number>): string | undefined {
  if (counts.size === 0) return undefined;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return entries.map(([k, v]) => `${k}×${v}`).join(', ');
}

/** verify-fix loop 的修复上下文 — 当验证失败回退到 build 阶段时注入 */
export interface FixContext {
  iteration: number;
  verifyFailures: string[];
  rawReport: string;
}

export interface PhaseContext {
  onTemporaryFile?: (file: string, present: boolean) => void;
  demand: DemandSpec;
  branchName: string;
  pipelineMode?: string;
  ports?: PortPair;
  fixContext?: FixContext;
  workspace?: WorkspaceLayout;
  workDir?: string;
}

/**
 * 阶段抽象基类 — 纯逻辑执行，零编排副作用。
 *
 * 阶段约定：
 * - run() 返回 PhaseResult（completed / failed / awaitGate / awaitAsync / requestRetryFrom）。
 * - 阶段内部不推进生命周期，也不触发 eventBus / git commit / GitHub 评论；
 *   这些副作用由编排器根据返回的 Intent 驱动。
 * - 阶段只通过 PlanPersistence 读写产物；执行会话凭证由 IssueTracker 持久化。
 *
 * 失败 → Intent 映射：
 * - 产物校验失败（无变更/缺产物）→ retryable='hard-no-auto'（自动重试无意义，需用户介入）
 * - AI 超时但仍在活跃输出 → retryable='soft'（不消耗 retry budget）
 * - AI 永久失败（auth/quota/model 不存在）→ retryable='hard-no-auto'
 * - 其他 AI 失败 → retryable='hard'
 */
export abstract class BasePhase {
  static readonly MIN_ARTIFACT_BYTES = 50;

  protected aiRunner: AIRunner;
  protected git: GitOperations;
  protected plan: PlanPersistence;
  protected config: Config;
  protected tracker?: IssueTracker;
  protected logger: Logger;
  private lastStreamSummary?: {
    eventTypeCounts: Map<string, number>;
    toolCallKeyCounts: Map<string, number>;
  };

  abstract readonly phaseName: string;

  constructor(
    aiRunner: AIRunner,
    git: GitOperations,
    plan: PlanPersistence,
    config: Config,
    tracker?: IssueTracker,
  ) {
    this.aiRunner = aiRunner;
    this.git = git;
    this.plan = plan;
    this.config = config;
    this.tracker = tracker;
    this.logger = rootLogger.child(this.constructor.name);
  }

  /** 获取阶段预期的产物文件列表。编排器需通过此方法同步产物到 Issue。 */
  getResultFiles(_ctx?: PhaseContext): Array<{ filename: string; label: string }> {
    return [];
  }

  /**
   * 执行阶段并返回意图 — 纯逻辑，零编排副作用。
   *
   * 子类可 override 此方法以表达更丰富的意图（如 VerifyPhase 返回 requestRetryFrom，
   * 审核阶段返回 awaitGate）。默认行为：成功 → completed，失败 → failed。
   */
  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const displayId = Number(ctx.demand.sourceRef.displayId);
    const expectedResultFiles = this.getResultFiles(ctx);

    this.lastStreamSummary = {
      eventTypeCounts: new Map(),
      toolCallKeyCounts: new Map(),
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
      result = await this.runWithResumeFallback(
        displayId, resumeInfo.sessionId!, this.getResumePrompt(ctx) + (rules ? `\n\n${t('basePhase.rulesSection', { rules })}` : ''),
        prompt, callbacks?.onStreamEvent,
      );
    } else {
      result = await this.runAI(
        displayId, prompt, undefined, callbacks?.onStreamEvent,
      );
    }

    if (!result.success) {
      this.persistSessionId(displayId, result.sessionId);
      const error = this.classifyFailure(result);
      return { kind: 'failed', error, sessionId: result.sessionId };
    }

    this.persistSessionId(displayId, result.sessionId);
    if (this.phaseName === 'plan') {
      if (result.output.trim().length < BasePhase.MIN_ARTIFACT_BYTES) return { kind: 'failed', error: { message: '计划内容为空或不完整', retryable: 'hard-no-auto' } };
      try { this.plan.writePlan(renderPlan(decodePlanContent(JSON.parse(result.output.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? result.output)))); }
      catch (error) { return { kind: 'failed', error: { message: `结构化计划无效：${(error as Error).message}`, retryable: 'hard' } }; }
    }
    if (this.phaseName === 'verify') this.plan.writeFile('02-verify-report.md', result.output);
    try {
      await this.validatePhaseOutput(ctx, displayId, expectedResultFiles);
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
      sessionId: result.sessionId,
      artifacts: this.toArtifactRefs(expectedResultFiles),
    };
  }

  protected abstract buildPrompt(ctx: PhaseContext): string;

  protected getRunMode(): 'plan' | 'agent' | undefined {
    return undefined;
  }

  protected getResumePrompt(_ctx: PhaseContext): string {
    return t('basePhase.resumePrompt');
  }

  protected resolveResumeInfo(issueIid: number): { resumable: boolean; sessionId?: string } {
    const progress = this.tracker?.getPhaseProgress(issueIid, this.phaseName);
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
      timeoutMs: this.config.ai.phaseTimeoutMs,
      idleTimeoutMs: this.config.ai.idleTimeoutMs,
      timeoutGraceMs: this.config.ai.timeoutGraceMs,
      timeoutExtensionMs: this.config.ai.timeoutExtensionMs,
      timeoutMaxExtensions: this.config.ai.timeoutMaxExtensions,
      mode: this.getRunMode(),
      model: this.config.ai.model,
      phaseName: this.phaseName,
      sessionId: options?.sessionId,
      continueSession: options?.continueSession,
      onStreamEvent: (event) => {
        this.captureStreamSummary(event);
        if (!capturedSessionId && event.type !== 'raw') {
          const content = event.content as Record<string, unknown>;
          const id = event.sessionId ?? content?.session_id;
          if (typeof id === 'string' && id) {
            capturedSessionId = id;
            this.persistSessionId(issueIid, capturedSessionId);
          }
        }
        onStreamEvent?.(event);
      },
    });
    if (result.sessionId) {
      this.persistSessionId(issueIid, result.sessionId);
    }
    return result;
  }

  protected async runWithResumeFallback(
    displayId: number,
    sessionId: string,
    resumePrompt: string,
    fullPrompt: string,
    onStreamEvent?: (event: StreamEvent) => void,
  ): Promise<RunResult> {
    const result = await this.runAI(displayId, resumePrompt, {
      sessionId,
      continueSession: true,
    }, onStreamEvent);

    if (!result.success && this.isResumeFailure(result)) {
      this.logger.warn(t('basePhase.resumeFallback'), {
        issueIid: displayId,
        phase: this.phaseName,
        exitCode: result.exitCode,
      });
      onStreamEvent?.({
        type: 'system',
        content: t('basePhase.resumeFallback'),
        timestamp: new Date().toISOString(),
      });
      return this.runAI(displayId, fullPrompt, undefined, onStreamEvent);
    }

    return result;
  }

  /**
   * 把 RunResult 翻译成结构化 PhaseError。
   *
   * - wasActiveAtTimeout=true → soft（不消耗 budget，下次续跑）
   * - 永久失败模式（model 不存在 / auth / quota） → hard-no-auto（必须用户介入）
   * - 其他 → hard（消耗 budget，达上限后转 manual）
   */
  protected classifyFailure(result: RunResult): PhaseError {
    const message = (result.errorMessage || result.output).slice(0, 500);
    const rawOutput = result.output;

    if (result.wasActiveAtTimeout) {
      return { message, retryable: 'soft', rawOutput };
    }

    const msg = (result.errorMessage ?? result.output ?? '').toLowerCase();
    const permanentPatterns = [
      /model\b.*\b(?:not found|not supported|unavailable|service info not found)/,
      /invalid.?api.?key/,
      /authentication.*(?:failed|denied|error)/,
      /permission.?denied/,
      /billing/,
      /quota.*exceeded/,
    ];
    if (permanentPatterns.some(p => p.test(msg))) {
      return { message, retryable: 'hard-no-auto', rawOutput };
    }

    return { message, retryable: 'hard', rawOutput };
  }

  /**
   * Heuristic: a resume failure is typically an immediate process exit
   * (exit code != 0, empty output) caused by an invalid/expired session ID.
   */
  private isResumeFailure(result: RunResult): boolean {
    if (result.success) return false;
    const msg = (result.errorMessage ?? '').toLowerCase();

    if (msg.includes('session') || msg.includes('resume') || msg.includes('session_id')) {
      return true;
    }

    if (result.output.length === 0 && result.exitCode !== null && result.exitCode !== 0) {
      const isConfigError = msg.includes('model') || msg.includes('api key') || msg.includes('authentication');
      return !isConfigError;
    }

    return false;
  }

  protected persistSessionId(issueIid: number, sessionId: string | undefined): void {
    if (sessionId) this.tracker?.updatePhaseProgress(issueIid, this.phaseName, { sessionId });
  }

  protected toArtifactRefs(files: ReadonlyArray<{ filename: string; label: string }>): readonly ArtifactRef[] {
    return files.map(f => ({ filename: f.filename, label: f.label }));
  }
  protected async resolveRules(_ctx: PhaseContext): Promise<string | null> { return resolvePromptRules(this.config.knowledge.enabled); }

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
    if (type !== 'tool_call') return;
    const content = event.content as Record<string, unknown> | undefined;
    const toolCall = content?.tool_call as Record<string, unknown> | undefined;
    if (!toolCall) return;
    for (const key of Object.keys(toolCall)) {
      summary.toolCallKeyCounts.set(key, (summary.toolCallKeyCounts.get(key) ?? 0) + 1);
    }
  }

  private formatStreamSummaryHint(): string | undefined {
    const summary = this.lastStreamSummary;
    if (!summary) return undefined;
    const parts: string[] = [];
    const events = formatCountsByDesc(summary.eventTypeCounts);
    if (events) parts.push(`流式事件: ${events}`);
    const tools = formatCountsByDesc(summary.toolCallKeyCounts);
    if (tools) parts.push(`工具调用: ${tools}`);
    return parts.length > 0 ? parts.join(' | ') : undefined;
  }
}
