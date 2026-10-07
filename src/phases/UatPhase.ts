import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { PlanPersistence } from '../persistence/PlanPersistence.js';
import type { Config } from '../config.js';
import type { IssueRun, TaskPlan } from '../dag/contracts.js';
import { decideUatOutcome, resolveVisualGaps } from '../e2e/UatOutcome.js';
import type { PhaseContext } from './BasePhase.js';
import type { PhaseCallbacks } from './PhaseCallbacks.js';
import type { PhaseResult } from '../orchestration/PhaseResult.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeUat } from '../e2e/PlaywrightRunner.js';
import { UatResultStore } from '../e2e/UatResultStore.js';
import { VisualReviewRunner } from '../e2e/VisualReviewRunner.js';
import { validateUatPreparation } from '../e2e/UatPreparation.js';
import { getIssueContext } from '../context/IssueContext.js';
import { ARTIFACTS, getPhaseArtifacts } from '../shared/runtime/artifacts.js';
import type {
  UatExecution,
  UatPolicySnapshot,
  VisualCoverageGap,
  VisualReviewResult,
} from '../shared/workbench.js';

/** 由编排层注入聚合事务，阶段不依赖具体 Tracker 实现。 */
export interface UatPhaseStore {
  get(number: number): { run: IssueRun } | undefined;
  transaction(
    number: number,
    update: (record: { run: IssueRun }) => void,
  ): unknown;
  store: { readPlan(number: number, revision: number, digest?: string): TaskPlan };
}

function createVisualReview(
  status: VisualReviewResult['status'],
  summary: string,
  reasonCode: string,
  evidence: string[],
  reviewRound: number,
  maxReviewRounds: number,
  unreviewedScreenshots = evidence,
): VisualReviewResult {
  return {
    status,
    summary,
    issues: [],
    selectedScreenshots: [],
    checkedScreenshots: [],
    unreviewedScreenshots,
    coverageGaps: [],
    coverageGapDetails: [],
    reviewRound,
    maxReviewRounds,
    reasonCode,
  };
}

/** 每次重试执行新的 Playwright 与视觉运行，不复用旧摘要。 */
export class UatPhase {
  readonly phaseName = 'uat';
  constructor(
    private runner: AIRunner,
    private plan: PlanPersistence,
    private config: Config,
    private tracker: UatPhaseStore,
  ) {}

  getResultFiles() {
    return getPhaseArtifacts('uat').map(({ filename, label }) => ({ filename, label }));
  }

  async run(ctx: PhaseContext, callbacks?: PhaseCallbacks): Promise<PhaseResult> {
    const number = Number(ctx.demand.sourceRef.displayId);
    const workDir = ctx.workDir || this.plan.baseDir;
    const tracker = this.tracker;
    const run = tracker.get(number)?.run;
    if (!run?.candidateCommit || !run.planDigest || !run.dispatchId) {
      throw new Error('UAT 缺少当前候选提交、计划或调度身份');
    }
    const runId = randomUUID();
    const policy: UatPolicySnapshot = {
      visualReviewEnabled: this.config.e2e.visualReviewEnabled,
      maxImages: this.config.e2e.visualReviewMaxImages,
      maxReviewRounds: this.config.e2e.visualReviewMaxRetries + 1,
      model: this.config.e2e.visualReviewModel,
      timeoutMs: this.config.e2e.visualReviewTimeoutMs,
    };
    const execution: UatExecution = {
      candidateCommit: run.candidateCommit,
      planRevision: run.planRevision,
      planDigest: run.planDigest,
      buildGeneration: run.buildGeneration,
      dispatchId: run.dispatchId,
      phaseAttemptNo: run.phaseExecutions.uat,
    };
    const store = new UatResultStore(this.plan.dataDirectory);
    let summary = store.createRunning({
      runId,
      issueIid: number,
      policy,
      execution,
      startedAt: new Date().toISOString(),
    });
    tracker.transaction(number, (record) => {
      record.run.uat = undefined;
      record.run.uatExecution = {
        runId,
        status: 'running',
        startedAt: summary.startedAt,
        execution: { ...execution },
        policy,
      };
    });
    const issueSignal = getIssueContext()?.signal;
    try {
      validateUatPreparation({
        workDir, dataDir: this.plan.dataDirectory, issueIid: number,
        plan: tracker.store.readPlan(number, run.planRevision, run.planDigest),
        e2e: this.config.e2e,
      });
    } catch (error) {
      const message = (error as Error).message;
      const visual = createVisualReview(
        'not-run', '准备检查未通过，未启动 Playwright 或视觉复核',
        'uat-preparation-invalid', [], run.uatReviewRounds + 1, policy.maxReviewRounds ?? 1,
      );
      summary = store.finalize({ ...summary, failureKind: 'environment', error: message }, visual);
      store.writeSummary(summary);
      store.writeDisplayCopies(
        summary, (filename, content) => this.plan.writeFile(filename, content),
      );
      tracker.transaction(number, (record) => {
        if (record.run.uatExecution?.runId !== runId) throw new Error('UAT 执行身份已失效');
        record.run.uatExecution.status = summary.status;
      });
      return { kind: 'failed', error: { message, retryable: 'hard-no-auto' } };
    }
    const outputDir = store.runDir(runId);
    const machine = await executeUat({
      issueIid: number, runId, dataDir: this.plan.dataDirectory, outputDir, signal: issueSignal,
      onTemporaryFile: ctx.onTemporaryFile, workDir, configFile: this.config.e2e.configFile,
      browserChannel: this.config.e2e.browserChannel,
      baseUrl: ctx.ports
        ? `http://127.0.0.1:${ctx.ports.frontendPort}`
        : this.config.e2e.baseUrl,
      timeoutMs: this.config.e2e.timeoutMs,
      onOutput: (text) => callbacks?.onStreamEvent?.({
        type: 'uat-output',
        content: text,
        timestamp: new Date().toISOString(),
      }),
    });
    if (machine.runId !== runId || machine.issueIid !== number) throw new Error('UAT 执行身份与当前任务不一致');
    summary = store.applyMachineResult(summary, machine);
    store.writeSummary(summary);
    const reviewRound = run.uatReviewRounds + 1;
    const maxReviewRounds = this.config.e2e.visualReviewMaxRetries + 1;
    let visual = createVisualReview(
      'needs-review',
      '视觉复核未完成',
      'visual-review-not-run',
      machine.screenshots.map((item) => item.id),
      reviewRound,
      maxReviewRounds,
    );
    if (!summary.machinePassed) {
      visual = createVisualReview(
        'not-run',
        '机器验收未通过，未执行视觉复核',
        issueSignal?.aborted ? 'cancelled' : 'machine-failed',
        machine.screenshots.map((item) => item.id),
        reviewRound,
        maxReviewRounds,
      );
    } else if (!policy.visualReviewEnabled) {
      visual = createVisualReview(
        'not-run',
        '视觉复核未启用',
        'disabled',
        machine.screenshots.map((item) => item.id),
        reviewRound,
        maxReviewRounds,
        [],
      );
    } else {
      let cases;
      let acceptance = new Map<string, string>();
      try {
        const prepared = validateUatPreparation({
          workDir, dataDir: this.plan.dataDirectory, issueIid: number,
          plan: tracker.store.readPlan(number, run.planRevision, run.planDigest),
          e2e: this.config.e2e,
        });
        acceptance = prepared.acceptance;
        cases = prepared.cases;
      } catch (error) {
        const gap: VisualCoverageGap = {
          description: (error as Error).message,
          kind: 'missing-case',
          acceptanceRefs: [],
          screenshotIds: [],
        };
        visual = {
          ...createVisualReview(
            'needs-review',
            '视觉用例清单无效或缺失',
            'visual-cases-invalid',
            machine.screenshots.map((item) => item.id),
            reviewRound,
            maxReviewRounds,
          ),
          coverageGaps: [gap.description],
          coverageGapDetails: [gap],
        };
        cases = undefined;
      }
      if (cases) {
        const review = new VisualReviewRunner();
        // 只引用当前候选提交的通过凭证，避免残留报告被当成本轮验证证据。
        const verify = run.verify;
        const currentVerify = verify?.passed
          && verify.commit === execution.candidateCommit
          && path.resolve(verify.reportPath)
            === path.resolve(this.plan.artifactPath(ARTIFACTS.verifyReport.filename));
        visual = await review.run({
          runner: this.runner,
          dataDir: this.plan.dataDirectory,
          runId,
          issueIid: number,
          policy,
          evidence: machine.screenshots,
          cases: cases.cases,
          acceptanceText: JSON.stringify({
            title: ctx.demand.title,
            description: ctx.demand.description,
            supplement: ctx.demand.supplement,
            approvedAcceptance: Object.fromEntries(acceptance),
          }),
          testContext: {
            playwright: {
              playwrightExitCode: machine.playwrightExitCode,
              reportValid: machine.reportValid,
              passedTests: machine.passedTests,
              failedTests: machine.failedTests,
              skippedTests: machine.skippedTests,
              reportErrors: machine.reportErrors,
            },
            verify: currentVerify
              ? {
                commit: verify.commit,
                completedAt: verify.completedAt,
                reportMarkdown: this.plan.readFile(ARTIFACTS.verifyReport.filename),
              }
              : undefined,
          },
          signal: issueSignal,
          onStreamEvent: callbacks?.onStreamEvent,
          onTemporaryDirectory: (directory, present) => {
            tracker.transaction(number, (record) => {
              const directories = (record.run.temporaryDirectories ?? [])
                .filter((item) => item.directory !== directory);
              if (present) {
                directories.push({
                  kind: 'visual-review',
                  runId,
                  directory,
                  dispatchId: execution.dispatchId,
                  createdAt: new Date().toISOString(),
                });
              }
              record.run.temporaryDirectories = directories;
            });
          },
        });
      }
    }
    const coveredBehaviorGaps = run.repairs.flatMap((repair) =>
      repair.visualDecision?.decision === 'behavior-covered'
        && repair.visual?.candidateCommit === execution.candidateCommit
        && repair.visual.planDigest === execution.planDigest
        && repair.visual.buildGeneration === execution.buildGeneration
        ? [repair.visual.gap] : [],
    );
    visual = {
      ...resolveVisualGaps(visual, coveredBehaviorGaps, runId),
      reviewRound,
      maxReviewRounds,
    };
    summary = store.finalize(
      summary,
      visual,
      issueSignal?.aborted ? 'cancelled' : 'completed',
    );
    store.writeSummary(summary);
    store.writeDisplayCopies(
      summary,
      (filename, content) => this.plan.writeFile(filename, content),
    );
    tracker.transaction(number, (record) => {
      if (record.run.uatExecution?.runId !== runId) throw new Error('UAT 执行身份已失效');
      record.run.uatExecution!.status = summary.status;
      record.run.temporaryDirectories = (record.run.temporaryDirectories ?? [])
        .filter((item) => item.runId !== runId);
    });
    const markdown = this.plan.readFile(ARTIFACTS.uatReport.filename) ?? '';
    if (summary.status === 'cancelled') issueSignal?.throwIfAborted();
    return decideUatOutcome(summary, markdown, {
      fixEnabled: this.config.verifyFixLoop.enabled,
      reviewRounds: run.uatReviewRounds,
      maxReviewRetries: this.config.e2e.visualReviewMaxRetries,
    });
  }
}
