import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { GitOperations } from '../git/GitOperations.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { Config } from '../config.js';
import type { PhaseSessionStore } from './PhaseSessionStore.js';
import { getPhaseArtifacts } from '../shared/runtime/artifacts.js';
import fs from 'node:fs';
import path from 'node:path';
import { type PhaseContext } from './BasePhase.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult } from '../orchestration/PhaseResult.js';
import { executeUat } from '../e2e/PlaywrightRunner.js';
import { getIssueContext } from '../context/IssueContext.js';
import { ARTIFACTS } from '../shared/runtime/artifacts.js';
/** 每次重试执行真实浏览器测试，不复用遗留 Markdown 报告。 */
export class UatPhase {
  readonly phaseName = 'uat';
  constructor(
    _runner: AIRunner,
    _git: GitOperations,
    private plan: PlanPersistence,
    private config: Config,
    _sessions?: PhaseSessionStore,
  ) {}
  getResultFiles() {
    return getPhaseArtifacts('uat').map(({ filename, label }) => ({ filename, label }));
  }
  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const number = Number(ctx.demand.sourceRef.displayId),
      workDir = ctx.workDir || this.plan.baseDir;
    if (!fs.existsSync(path.resolve(workDir, this.config.e2e.configFile)))
      return {
        kind: 'failed',
        error: {
          message: '构建收尾未生成 Playwright 配置，请人工检查环境',
          retryable: 'hard-no-auto',
        },
      };
    const result = await executeUat({
      onTemporaryFile: ctx.onTemporaryFile,
      signal: getIssueContext()?.signal,
      issueIid: number,
      workDir,
      configFile: this.config.e2e.configFile,
      baseUrl: ctx.ports ? `http://127.0.0.1:${ctx.ports.frontendPort}` : this.config.e2e.baseUrl,
      timeoutMs: this.config.e2e.timeoutMs,
      onOutput: (text) =>
        callbacks?.onStreamEvent?.({
          type: 'uat-output',
          content: text,
          timestamp: new Date().toISOString(),
        }),
    });
    this.plan.writeFile(ARTIFACTS.uatRun.filename, JSON.stringify(result));
    const markdown = `# 浏览器验收报告\n\n运行：${result.runId}\n结果：${result.passed ? '通过' : '失败'}\n通过 ${result.passedTests}，失败 ${result.failedTests}，跳过 ${result.skippedTests}\n\n${result.error || ''}\n\n[HTML 报告](/api/uat/runs/${result.runId}/files/report/index.html)\n`;
    this.plan.writeFile(ARTIFACTS.uatReport.filename, markdown);
    if (!result.passed && result.failureKind === 'assertion' && this.config.verifyFixLoop.enabled)
      return {
        kind: 'requestRetryFrom',
        targetPhaseId: 'build',
        reason: 'uat-assertion-failed',
        context: { verifyFailures: [result.error || '浏览器断言失败'], rawReport: markdown },
      };
    return result.passed
      ? {
          kind: 'completed',
          output: markdown,
          artifacts: this.getResultFiles(),
        }
      : {
          kind: 'failed',
          error: {
            message: result.error || '浏览器验收失败',
            retryable: 'hard-no-auto',
            rawOutput: markdown,
          },
        };
  }
}
