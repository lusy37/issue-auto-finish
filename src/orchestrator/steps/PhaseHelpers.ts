/**
 * 从 PhaseLoopStep 提取的编排级辅助函数。
 *
 * 供阶段副作用执行器和交付步骤共用。
 */
import type { GitOperations } from '../../git/GitOperations.js';
import { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { BasePhase, PhaseContext } from '../../phases/BasePhase.js';
import type { IssueProcessingContext, OrchestratorDeps } from '../IssueProcessingContext.js';
import type { PullRequestResult } from '../PipelineOrchestrator.js';
import { isNoteSyncEnabledForIssue } from '../../notesync/NoteSyncSettings.js';
import { truncateToSummary, buildNoteSyncComment } from '../../notesync/NoteSyncSettings.js';
import { issueProgressComment } from '../../prompts/templates.js';
import { logger as rootLogger } from '../../logger.js';
import { t } from '../../i18n/index.js';

const logger = rootLogger.child('PhaseHelpers');

// ── 安全评论 ──

export async function safeComment(deps: OrchestratorDeps, issueId: number, message: string): Promise<void> {
  try {
    await deps.github.createIssueNote(issueId, message);
  } catch { /* ignore */ }
}

// ── PR 创建（幂等）──


export async function ensurePrCreated(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
): Promise<PullRequestResult | null> {
  const record = deps.tracker.get(ctx.issue.number);
  if (record?.prUrl) {
    return { url: record.prUrl, number: 0 };
  }

  const previewUrl = deps.buildPreviewUrl(ctx.issue.number);
  const pr = await deps.tryCreatePullRequest(
    ctx.issue,
    ctx.branchName,
    ctx.wtCtx.workDir,
    previewUrl,
  );

  if (pr?.url && record) {
    deps.tracker.updateState(ctx.issue.number, record.state, { prUrl: pr.url });
  }

  return pr;
}

// ── Git 提交 ──

/** 使用本地 Git 身份提交，提交信息关联 Issue 编号。 */
export function buildAutoCommitMessage(
  phaseName: string,
  displayId: number,
): string {
  const subject = `chore(auto): ${phaseName} phase completed for issue #${displayId}`;
  return subject;
}

export async function commitPlanFiles(
  ctx: PhaseContext,
  wtGit: GitOperations,
  phaseName: string,
  displayId: number,
): Promise<void> {
  const commitMsg = buildAutoCommitMessage(phaseName, displayId);
  if (await wtGit.hasChanges()) {
    if (ctx.workDir) PlanPersistence.ensureGitignore(ctx.workDir);
    await wtGit.add(['.']);
    await wtGit.commit(commitMsg);
    await wtGit.push(ctx.branchName);
  }
}

// ── 产物同步到 Issue ──

export async function syncResultToIssue(
  phase: BasePhase,
  ctx: PhaseContext,
  displayId: number,
  phaseName: string,
  deps: OrchestratorDeps,
  issueId: number,
  wtPlan: PlanPersistence,
): Promise<void> {
  try {
    const enabled = isNoteSyncEnabledForIssue(displayId, deps.tracker, deps.config);
    const resultFiles = phase.getResultFiles(ctx);

    if (!enabled || resultFiles.length === 0) {
      await safeComment(deps, issueId, issueProgressComment(phaseName, 'completed'));
      return;
    }

    const baseUrl = deps.config.issueNoteSync.webBaseUrl.replace(/\/$/, '');
    const phaseLabel = t(`phase.${phaseName}`) || phaseName;
    const dashboardUrl = `${baseUrl}/?issue=${displayId}`;

    for (const file of resultFiles) {
      const content = wtPlan.readFile(file.filename);
      if (!content) continue;

      const summary = truncateToSummary(content);
      const docUrl = `${baseUrl}/doc/${displayId}/${file.filename}`;
      const comment = buildNoteSyncComment(
        phaseName, file.label || phaseLabel, docUrl, dashboardUrl, summary,
      );

      await safeComment(deps, issueId, comment);
      logger.info('Result synced to issue', { issueIid: displayId, file: file.filename });
    }
  } catch (err) {
    logger.warn('Failed to sync result to issue', { error: (err as Error).message });
    await safeComment(deps, issueId, issueProgressComment(phaseName, 'completed'));
  }
}

// ── 工具函数 ──

export function findPreviousAiPhaseIndex(
  phases: readonly { kind: string }[],
  currentIdx: number,
): number {
  for (let j = currentIdx - 1; j >= 0; j--) {
    if (phases[j].kind === 'ai') return j;
  }
  return -1;
}
