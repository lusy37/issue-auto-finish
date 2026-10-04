import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { ensureDir } from '../paths.js';
import { UAT_FORMAT } from '../shared/runtime/formats.js';
import { uatResultSchema } from './UatSchemas.js';
import type {
  MachineUatResult,
  UatExecution,
  UatPolicySnapshot,
  UatResult,
  VisualReviewResult,
} from '../shared/workbench.js';
import type { UatAcceptanceReceipt } from '../dag/contracts.js';

export interface UatReceiptExpectation {
  candidateCommit: string;
  planRevision: number;
  planDigest: string;
  buildGeneration: number;
  summaryDigest?: string;
  visualReviewEnabled?: boolean;
}

export type CompletedUatResult = UatResult & {
  status: 'completed';
  passed: true;
  finishedAt: string;
  summaryDigest: string;
};

function digestOf(value: UatResult): string {
  const { summaryDigest: _ignored, ...withoutDigest } = value;
  // Zod 按摘要 schema 生成规范化对象；哈希只依赖校验后的字段和值。
  const parsed = uatResultSchema.parse(withoutDigest);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}

export class UatResultStore {
  constructor(private readonly dataDir: string) {}

  runDir(runId: string): string { return path.join(this.dataDir, 'uat', runId); }
  private ensureRun(runId: string): string { return ensureDir(this.runDir(runId)); }
  private file(runId: string, name: string): string { return path.join(this.runDir(runId), name); }

  createRunning(args: {
    runId: string;
    issueIid: number;
    policy: UatPolicySnapshot;
    execution: UatExecution;
    startedAt: string;
  }): UatResult {
    const result: UatResult = {
      format: UAT_FORMAT, status: 'running', runId: args.runId, issueIid: args.issueIid,
      machinePassed: false, passed: false, passedTests: 0, failedTests: 0, skippedTests: 0,
      evidence: [], reportAvailable: false, startedAt: args.startedAt,
      visualReview: {
        status: args.policy.visualReviewEnabled ? 'pending' : 'not-run',
        summary: args.policy.visualReviewEnabled ? '等待机器验收结果' : '视觉复核未启用',
        issues: [], selectedScreenshots: [], checkedScreenshots: [], unreviewedScreenshots: [],
        coverageGaps: [], coverageGapDetails: [],
        reviewRound: 1, maxReviewRounds: (args.policy.maxReviewRounds ?? 1),
        reasonCode: args.policy.visualReviewEnabled ? 'machine-pending' : 'disabled',
      }, policy: args.policy, execution: args.execution,
    };
    this.ensureRun(args.runId);
    writeJsonAtomicSync(this.file(args.runId, 'summary.json'), result);
    return result;
  }

  writeVisual(runId: string, visual: VisualReviewResult): void {
    this.ensureRun(runId);
    writeJsonAtomicSync(this.file(runId, 'visual.json'), visual);
  }

  /** 将本轮 Playwright 结果合并到摘要，供视觉复核和最终凭证共同使用。 */
  applyMachineResult(base: UatResult, machine: MachineUatResult): UatResult {
    return {
      ...base,
      passedTests: machine.passedTests,
      failedTests: machine.failedTests,
      skippedTests: machine.skippedTests,
      evidence: machine.screenshots,
      reportAvailable: machine.reportAvailable,
      machineFinishedAt: machine.machineFinishedAt,
      machinePassed: machine.passed,
      failureKind: machine.failureKind,
      error: machine.error
        || (machine.reportErrors.length ? machine.reportErrors.join('\n') : undefined),
    };
  }

  finalize(
    base: UatResult,
    visual: VisualReviewResult,
    status: UatResult['status'] = 'completed',
  ): UatResult {
    const passed = status === 'completed'
      && base.machinePassed
      && (!base.policy.visualReviewEnabled || visual.status === 'passed');
    const result: UatResult = {
      ...base, status, passed,
      finishedAt: status === 'completed' ? new Date().toISOString() : undefined,
      visualReview: visual,
    };
    if (result.finishedAt) result.summaryDigest = digestOf(result);
    this.writeVisual(result.runId, visual);
    return result;
  }

  writeSummary(result: UatResult): void {
    this.ensureRun(result.runId);
    writeJsonAtomicSync(this.file(result.runId, 'summary.json'), result);
  }

  markInterrupted(runId: string, message = '服务重启时 UAT 尚未完成'): UatResult | undefined {
    if (!fs.existsSync(this.file(runId, 'summary.json'))) return undefined;
    const current = this.readSummary(runId);
    if (current.status !== 'running') return current;
    const result: UatResult = {
      ...current,
      status: 'interrupted',
      machinePassed: false,
      passed: false,
      finishedAt: undefined,
      summaryDigest: undefined,
      visualReview: {
        ...current.visualReview,
        status: 'not-run',
        summary: '服务重启时视觉复核未完成',
        checkedScreenshots: [],
        unreviewedScreenshots: current.evidence.map((item) => item.id),
        reasonCode: 'interrupted',
      },
      error: message,
    };
    this.writeSummary(result);
    return result;
  }

  readSummary(runId: string): UatResult {
    const raw = JSON.parse(fs.readFileSync(this.file(runId, 'summary.json'), 'utf8')) as unknown;
    const value = uatResultSchema.parse(raw) as UatResult;
    if (value.runId !== runId) throw new Error('UAT 摘要格式或运行编号无效');
    if (
      value.status === 'completed'
      && (!value.finishedAt
        || !value.summaryDigest
        || digestOf(value) !== value.summaryDigest)
    ) {
      throw new Error('UAT 终态摘要缺少有效摘要');
    }
    return value;
  }

  /** 读取并校验当前候选提交的唯一 UAT 凭证。 */
  assertCurrentReceipt(runId: string, expected: UatReceiptExpectation): CompletedUatResult {
    const summary = this.readSummary(runId);
    if (
      summary.status !== 'completed'
      || !summary.passed
      || summary.execution.candidateCommit !== expected.candidateCommit
      || summary.execution.planRevision !== expected.planRevision
      || summary.execution.planDigest !== expected.planDigest
      || summary.execution.buildGeneration !== expected.buildGeneration
      || (expected.summaryDigest !== undefined && summary.summaryDigest !== expected.summaryDigest)
      || (expected.visualReviewEnabled !== undefined
        && summary.policy.visualReviewEnabled !== expected.visualReviewEnabled)
    ) {
      throw new Error('UAT 凭证与当前候选提交或执行上下文不一致');
    }
    return summary as CompletedUatResult;
  }

  createReceipt(
    runId: string,
    expected: UatReceiptExpectation,
    reportPath: string,
  ): UatAcceptanceReceipt {
    const summary = this.assertCurrentReceipt(runId, expected);
    return {
      commit: summary.execution.candidateCommit,
      completedAt: summary.finishedAt,
      passed: true,
      reportPath,
      runId,
      uatEvidence: {
        format: summary.format,
        summaryDigest: summary.summaryDigest,
        execution: summary.execution,
        policy: summary.policy,
      },
    };
  }

  writeDisplayCopies(
    result: UatResult,
    writeArtifact: (filename: string, content: string) => void,
  ): void {
    const visual = result.visualReview;
    const lines = [
      '# 浏览器验收报告',
      '',
      `运行：${result.runId}`,
      `状态：${result.status}`,
      `机器结果：${result.machinePassed ? '通过' : '失败'}`,
      `最终结果：${result.passed ? '通过' : '未通过'}`,
      `通过 ${result.passedTests}，失败 ${result.failedTests}，跳过 ${result.skippedTests}`,
      `视觉复核：${visual.status}`,
      `送审 ${visual.selectedScreenshots.length}，已复核 ${visual.checkedScreenshots.length}，未复核 ${visual.unreviewedScreenshots.length}`,
      visual.coverageGaps.length ? `覆盖缺口：${visual.coverageGaps.join('；')}` : '',
      result.error || visual.error || '',
      `[HTML 报告](/api/uat/runs/${encodeURIComponent(result.runId)}/files/report/index.html)`, '',
    ];
    for (const issue of visual.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.description}`
        + `（${issue.sceneId} ${issue.viewport.width}x${issue.viewport.height}）`,
      );
    }
    writeArtifact('uat-run.json', JSON.stringify(result, null, 2));
    writeArtifact(
      '03-uat-report.md',
      lines.filter((line, index) => line || index === 0).join('\n'),
    );
  }

  static digest(result: UatResult): string { return digestOf(result); }
}
