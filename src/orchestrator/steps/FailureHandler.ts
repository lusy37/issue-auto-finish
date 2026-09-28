import { ISSUE_LABELS, withWorkbenchLabels } from '../../clients/IssueLabels.js';
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
  logger.error('Issue processing failed', {
    number: issue.number,
    error: errorMsg,
    isRetryable,
    wasActiveAtTimeout,
  });

  const currentRecord = deps.tracker.get(issue.number);
  const currentLifecycle = currentRecord?.lifecycle;
  // 通过 resetGeneration 精确检测并发重置：
  // 处理启动时快照 generation，若中途 restartIssue 调用 resetFull 使其递增，
  // 快照值将与当前值不同 → 说明是并发重置，应跳过 markFailed 防止覆盖新状态。
  // 相等则说明是重置后的正常失败，应正常标记。
  const currentGeneration = currentRecord?.resetGeneration ?? 0;
  const wasReset = (startResetGeneration ?? 0) !== currentGeneration;

  // 首轮阶段失败可能已经由 IssueWorkflow 写入 failed；setup 失败则不同：
  // setup 在进入工作流前执行，重试时生命周期仍停留在上一次的 failed(auto)。
  // 如果这里一律跳过 markFailed，poller 每次都会重新进入 setup，但永远不会
  // 消耗重试额度，最终形成“fetch -> Git 失败 -> fetch”的无限循环。
  // manual 失败仍保持幂等，不被后台执行覆盖；auto 失败需要为本次 setup 重试
  // 再记一次预算。
  const shouldPersistFailure =
    currentLifecycle?.kind !== 'failed' || currentLifecycle.retry === 'auto';
  if (shouldPersistFailure && !wasReset) {
    if (wasActiveAtTimeout) {
      deps.tracker.markFailedSoft(issue.number, errorMsg.slice(0, 500));
    } else {
      deps.tracker.markFailed(issue.number, errorMsg.slice(0, 500), isRetryable);
    }
  }

  if (wasReset) {
    logger.info('Issue was reset during processing, skipping failure marking', {
      number: issue.number,
    });
    throw err;
  }

  // 中止操作已在 catch 块中将状态设为 Paused，此处跳过失败处理（含 preview 停止）
  if (currentLifecycle?.kind === 'paused') {
    logger.info('Issue was paused during processing, skipping failure handling', {
      number: issue.number,
    });
    throw err;
  }

  try {
    await deps.github.updateIssueLabels(
      issue.number,
      withWorkbenchLabels(issue.labels, [ISSUE_LABELS.root, ISSUE_LABELS.failed]),
    );
  } catch {
    /* ignore */
  }

  try {
    await deps.github.createIssueNote(
      issue.number,
      t('orchestrator.failedComment', { error: errorMsg }),
    );
  } catch {
    /* ignore */
  }

  await deps.stopPreviewServers(issue.number);

  const preservedDirs = wtCtx.workspace ? [wtCtx.workspace.primary.gitRootDir] : [wtCtx.gitRootDir];
  logger.info('Worktree(s) preserved for debugging', {
    primary: wtCtx.gitRootDir,
    all: preservedDirs,
  });
  throw err;
}
