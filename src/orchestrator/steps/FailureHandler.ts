import { IssueState } from '../../tracker/IssueState.js';
import type { GitHubIssue } from '../../clients/GitHubClient.js';
import type { WorktreeContext } from '../../git/WorktreeContext.js';
import type { OrchestratorDeps } from '../IssueProcessingContext.js';
import { AIExecutionError } from '../../errors/index.js';
import { logger as rootLogger } from '../../logger.js';
import { t } from '../../i18n/index.js';

const logger = rootLogger.child('FailureHandler');

export async function handleFailure(
  err: unknown,
  issue: GitHubIssue,
  wtCtx: WorktreeContext,
  deps: OrchestratorDeps,
  startResetGeneration?: number,
): Promise<void> {
  const errorMsg = (err as Error).message;
  const isRetryable = err instanceof AIExecutionError ? err.isRetryable : true;
  const wasActiveAtTimeout = err instanceof AIExecutionError && err.wasActiveAtTimeout;
  logger.error('Issue processing failed', { number: issue.number, error: errorMsg, isRetryable, wasActiveAtTimeout });

  const currentRecord = deps.tracker.get(issue.number);
  const failedAtState = currentRecord?.state || IssueState.Pending;
  // 通过 resetGeneration 精确检测并发重置：
  // 处理启动时快照 generation，若中途 restartIssue 调用 resetFull 使其递增，
  // 快照值将与当前值不同 → 说明是并发重置，应跳过 markFailed 防止覆盖新状态。
  // 相等则说明是重置后的正常失败，应正常标记。
  const currentGeneration = currentRecord?.resetGeneration ?? 0;
  const wasReset = (startResetGeneration ?? 0) !== currentGeneration;

  if (failedAtState !== IssueState.Failed && !wasReset) {
    if (wasActiveAtTimeout) {
      deps.tracker.markFailedSoft(issue.number, errorMsg.slice(0, 500), failedAtState);
    } else {
      deps.tracker.markFailed(issue.number, errorMsg.slice(0, 500), failedAtState, isRetryable);
    }
  }

  if (wasReset) {
    logger.info('Issue was reset during processing, skipping failure marking', { number: issue.number });
    throw err;
  }

  // 中止操作已在 catch 块中将状态设为 Paused，此处跳过失败处理（含 preview 停止）
  if (failedAtState === IssueState.Paused) {
    logger.info('Issue was paused during processing, skipping failure handling', { number: issue.number });
    throw err;
  }

  try {
    await deps.github.updateIssueLabels(issue.number, [
      ...issue.labels.filter(l => !l.startsWith('auto-finish:') && l !== 'auto-finish'),
      'auto-finish', 'auto-finish:failed',
    ]);
  } catch { /* ignore */ }

  try {
    await deps.github.createIssueNote(
      issue.number,
      t('orchestrator.failedComment', { error: errorMsg }),
    );
  } catch { /* ignore */ }

  deps.stopPreviewServers(issue.number);

  const preservedDirs = wtCtx.workspace
    ? [wtCtx.workspace.primary.gitRootDir]
    : [wtCtx.gitRootDir];
  logger.info('Worktree(s) preserved for debugging', {
    primary: wtCtx.gitRootDir,
    all: preservedDirs,
  });
  throw err;
}
