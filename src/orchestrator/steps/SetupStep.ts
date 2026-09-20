import { ISSUE_LABELS, withWorkbenchLabels } from '../../clients/IssueLabels.js';
import { GitOperations } from '../../git/GitOperations.js';
import { PlanPersistence } from '../../persistence/PlanPersistence.js';
import type { IssueProcessingContext, OrchestratorDeps, SetupResult } from '../IssueProcessingContext.js';
import { logger as rootLogger } from '../../logger.js';
import { t } from '../../i18n/index.js';
import { applyIssueLifecycleEvent } from '../../tracker/IssueLifecycle.js';

const logger = rootLogger.child('SetupStep');

/**
 * 执行 Issue 处理的初始化步骤：
 * - 更新标签为 processing
 * - fetch + 创建 worktree（受 mutex 保护，通过 WorkspaceManager）
 * - 更新状态为 BranchCreated
 * - 安装依赖
 * - 初始化 PlanPersistence（ensureDir, writeIssueMeta）
 */
export async function executeSetup(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
): Promise<SetupResult> {
  const { issue, wtCtx, record, pipelineDef } = ctx;

  // 1. 更新标签
  try {
    await deps.github.updateIssueLabels(issue.number, withWorkbenchLabels(issue.labels, [ISSUE_LABELS.root, ISSUE_LABELS.processing]));
  } catch (err) {
    logger.warn('Failed to update issue labels', { error: (err as Error).message });
  }

  // 2. fetch + worktree (always via WorkspaceManager)
  await deps.mainGitMutex.runExclusive(async () => {
    deps.emitProgress(issue.number, 'fetch', t('orchestrator.fetchProgress'));
    await deps.mainGit.fetch();
    deps.emitProgress(issue.number, 'worktree', t('orchestrator.worktreeProgress'));
    await deps.ensureWorktree(wtCtx);
  }, deps.signal);

  // 3. 首次 setup 固化本轮阶段定义，并初始化展示进度。
  if (!record.run!.workflow.definition || !record.phaseProgress) {
    deps.tracker.initPhaseProgress(issue.number, pipelineDef);
  }

  // 4. 更新状态为 BranchCreated
  if (record.lifecycle.kind === 'pending') {
    deps.tracker.transaction(issue.number, current => {
      applyIssueLifecycleEvent(current, { type: 'setup-completed' });
    });
  }

  // 5. 安装依赖
  deps.emitProgress(issue.number, 'install', t('orchestrator.installProgress'));
  if (wtCtx.workspace) {
    await deps.installDependencies(wtCtx.workspace.primary.workDir);
  } else {
    await deps.installDependencies(wtCtx.workDir);
  }

  // 6. 初始化 PlanPersistence（在 primary repo）
  deps.emitProgress(issue.number, 'init_plan', t('orchestrator.initPlanProgress'));
  const primaryWorkDir = wtCtx.workspace ? wtCtx.workspace.primary.workDir : wtCtx.workDir;
  const primaryGitRoot = wtCtx.workspace ? wtCtx.workspace.primary.gitRootDir : wtCtx.gitRootDir;
  const wtGit = new GitOperations(primaryGitRoot, deps.signal);
  const wtPlan = new PlanPersistence(primaryWorkDir, issue.number, deps.tracker.store.dataDir, deps.tracker);

  wtPlan.ensureDir();
  wtPlan.writeIssueMeta({
    id: issue.number,
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    state: issue.state,
  });

  return { wtGit, wtPlan };
}
