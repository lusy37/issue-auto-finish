import fs from "node:fs";
import path from "node:path";
import { BasePhase, type PhaseContext } from "./BasePhase.js";
import type { PhaseCallbacks } from "./PhaseCallbacks.js";
import type { PhaseIntent } from "../orchestration/Intent.js";
import { executeUat } from "../e2e/PlaywrightRunner.js";
import { getIssueContext } from '../context/IssueContext.js';
/** 每次重试执行真实浏览器测试，不复用遗留 Markdown 报告。 */
export class UatPhase extends BasePhase {
  readonly phaseName = "uat";
  getResultFiles() {
    return [{ filename: "03-uat-report.md", label: "浏览器验收报告" }];
  }
  protected buildPrompt(ctx: PhaseContext): string {
    return `请为当前需求补充 Playwright Chromium 浏览器验收测试和配置 ${this.config.e2e.configFile}。\n需求：${ctx.demand.title}\n${ctx.demand.description}\n通过 process.env.UAT_BASE_URL 读取预览地址。服务端将实际执行测试，请勿生成验收结论。`;
  }
  async run(
    ctx: PhaseContext,
    callbacks?: PhaseCallbacks,
  ): Promise<PhaseIntent> {
    const number = Number(ctx.demand.sourceRef.displayId),
      workDir = ctx.workDir || this.plan.baseDir;
    if (!fs.existsSync(path.resolve(workDir, this.config.e2e.configFile))) return { kind: 'failed', error: { message: '构建收尾未生成 Playwright 配置，请人工检查环境', retryable: 'hard-no-auto' } };
    const result = await executeUat({
      onTemporaryFile: ctx.onTemporaryFile,
      signal: getIssueContext()?.signal,
      issueIid: number,
      workDir,
      configFile: this.config.e2e.configFile,
      baseUrl: ctx.ports
        ? `http://127.0.0.1:${ctx.ports.frontendPort}`
        : this.config.e2e.baseUrl,
      timeoutMs: this.config.e2e.timeoutMs,
      onOutput: (text) =>
        callbacks?.onStreamEvent?.({
          type: "uat-output",
          content: text,
          timestamp: new Date().toISOString(),
        }),
    });
    this.plan.ensureDir();
    fs.writeFileSync(
      path.join(this.plan.planDir, "uat-run.json"),
      JSON.stringify(result),
    );
    const markdown = `# 浏览器验收报告\n\n运行：${result.runId}\n结果：${result.passed ? "通过" : "失败"}\n通过 ${result.passedTests}，失败 ${result.failedTests}，跳过 ${result.skippedTests}\n\n${result.error || ""}\n\n[HTML 报告](/api/uat/runs/${result.runId}/files/report/index.html)\n`;
    fs.writeFileSync(
      path.join(this.plan.planDir, "03-uat-report.md"),
      markdown,
    );
    if (!result.passed && result.failureKind === 'assertion' && this.config.verifyFixLoop.enabled) return { kind: 'requestRetryFrom', targetPhaseId: 'build', reason: 'uat-assertion-failed', context: { verifyFailures: [result.error || '浏览器断言失败'], rawReport: markdown } };
    return result.passed
      ? {
          kind: "completed",
          output: markdown,
          artifacts: this.toArtifactRefs(this.getResultFiles()),
        }
      : {
          kind: "failed",
          error: {
            message: result.error || "浏览器验收失败",
            retryable: "hard-no-auto",
            rawOutput: markdown,
          },
        };
  }
}
