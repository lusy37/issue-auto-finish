import type { PhaseResult } from '../orchestration/PhaseResult.js';
import { getPhaseArtifacts } from '../shared/runtime/artifacts.js';
import type { UatResult, VisualCoverageGap, VisualReviewResult } from '../shared/workbench.js';

function coverageGapKey(gap: VisualCoverageGap): string {
  return JSON.stringify([
    gap.kind,
    [...gap.acceptanceRefs].sort(),
    gap.caseId ?? '',
    gap.sceneId ?? '',
    gap.viewport?.width ?? 0,
    gap.viewport?.height ?? 0,
    [...gap.screenshotIds].sort(),
    gap.description,
  ]);
}

/** 行为测试只能消除已确认的缺口，剩余缺口或未审图片仍阻止通过。 */
export function resolveVisualGaps(
  visual: VisualReviewResult,
  coveredGaps: VisualCoverageGap[],
  runId: string,
): VisualReviewResult {
  const covered = new Set(coveredGaps.map(coverageGapKey));
  const gaps = visual.coverageGapDetails ?? [];
  const unresolved = gaps.filter((gap) => !covered.has(coverageGapKey(gap)))
    .sort((a, b) => coverageGapKey(a).localeCompare(coverageGapKey(b)));
  const resolved = visual.reasonCode === 'visual-coverage-gaps'
    && gaps.length > 0 && unresolved.length === 0
    && visual.issues.length === 0 && visual.unreviewedScreenshots.length === 0;
  return {
    ...visual,
    ...(resolved ? {
      status: 'passed' as const,
      reasonCode: undefined,
      summary: '视觉缺口已由当前候选提交的行为测试覆盖',
    } : {}),
    coverageGaps: unresolved.map((gap) => gap.description),
    coverageGapDetails: unresolved.map((gap, gapIndex) => ({
      ...gap, gapIndex, sourceRunId: runId,
    })),
  };
}

/** 将已保存的验收事实转换为阶段意图，不执行 I/O。 */
export function decideUatOutcome(
  summary: UatResult,
  markdown: string,
  options: { fixEnabled: boolean; reviewRounds: number; maxReviewRetries: number },
): PhaseResult {
  if (!summary.passed && summary.failureKind === 'assertion' && options.fixEnabled) {
    return {
      kind: 'requestRetryFrom',
      targetPhaseId: 'build',
      reason: 'uat-assertion-failed',
      context: {
        verifyFailures: [summary.error || '浏览器断言失败'],
        rawReport: markdown,
      },
    };
  }
  const transientVisualReasons = new Set([
    'uat-visual-review-timeout',
    'uat-visual-review-environment',
  ]);
  if (
    !summary.passed
    && summary.visualReview.status === 'needs-review'
    && transientVisualReasons.has(summary.visualReview.reasonCode ?? '')
  ) {
    const used = options.reviewRounds;
    if (used < options.maxReviewRetries) {
      return {
        kind: 'retryCurrent',
        phaseId: 'uat',
        reason: summary.visualReview.reasonCode ?? 'visual-review-runtime',
        context: { runId: summary.runId },
      };
    }
  }
  const gap = summary.visualReview.coverageGapDetails?.[0];
  if (
    !summary.passed
    && options.fixEnabled
    && (summary.visualReview.status === 'failed' || gap)
  ) {
    return {
      kind: 'requestRetryFrom',
      targetPhaseId: 'build',
      reason: 'uat-visual-failed',
      context: {
        verifyFailures: summary.visualReview.issues.map((item) => (
          `[${item.severity}] ${item.sceneId} `
          + `${item.viewport.width}x${item.viewport.height}：${item.description}；`
          + `期望：${item.expected}；观察：${item.observed}；`
          + `截图：${item.screenshot}；运行：${summary.runId}`
        )),
        rawReport: markdown,
        visualRepair: gap
          ? {
            sourceRunId: summary.runId,
            candidateCommit: summary.execution.candidateCommit,
            planRevision: summary.execution.planRevision,
            planDigest: summary.execution.planDigest,
            buildGeneration: summary.execution.buildGeneration,
            gap,
            report: markdown,
          }
          : undefined,
      },
    };
  }
  if (summary.passed) {
    return {
      kind: 'completed',
      output: markdown,
      artifacts: getPhaseArtifacts('uat').map(({ filename, label }) => ({ filename, label })),
    };
  }
  return {
    kind: 'failed',
    error: {
      message: summary.visualReview.error
        || summary.error
        || (summary.visualReview.status === 'needs-review'
          ? '视觉验收需要人工复核'
          : '浏览器验收失败'),
      retryable: 'hard-no-auto',
      rawOutput: markdown,
    },
  };
}
