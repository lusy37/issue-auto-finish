/**
 * 从 PhaseLoopStep 提取的编排级辅助函数。
 *
 * 供阶段副作用执行器和交付步骤共用。
 */
import type { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { BasePhase, PhaseContext } from '../../phases/BasePhase.js';
import type { OrchestratorDeps } from '../IssueProcessingContext.js';
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
