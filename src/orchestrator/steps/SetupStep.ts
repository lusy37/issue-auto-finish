import { GitOperations } from '../../git/GitOperations.js';
import { PlanPersistence } from '../../persistence/PlanPersistence.js';
import { IssueState } from '../../tracker/IssueState.js';
import type { IssueProcessingContext, OrchestratorDeps, SetupResult } from '../IssueProcessingContext.js';
import { logger as rootLogger } from '../../logger.js';
import { t } from '../../i18n/index.js';

const logger = rootLogger.child('SetupStep');

/**
 * 执行 Issue 处理的初始化步骤：
 * - 更新标签为 processing
 * - fetch + 创建 worktree（受 mutex 保护，通过 WorkspaceManager）
 * - 更新状态为 BranchCreated
 * - 安装依赖
 * - 初始化 PlanPersistence（ensureDir, writeIssueMeta, writeProgress）
 */
export async function executeSetup(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
): Promise<SetupResult> {
  const { issue, wtCtx, record, pipelineDef, branchName } = ctx;

  // 1. 更新标签
  try {
    await deps.github.updateIssueLabels(issue.number, [
      ...issue.labels.filter(l => !l.startsWith('auto-finish:')),
      'auto-finish:processing',
    ]);
  } catch (err) {
    logger.warn('Failed to update issue labels', { error: (err as Error).message });
  }

  // 2. fetch + worktree (always via WorkspaceManager)
  await deps.mainGitMutex.runExclusive(async () => {
    deps.emitProgress(issue.number, 'fetch', t('orchestrator.fetchProgress'));
    await deps.mainGit.fetch();
    deps.emitProgress(issue.number, 'worktree', t('orchestrator.worktreeProgress'));
    await deps.ensureWorktree(wtCtx);
  });

  // 3. 更新状态为 BranchCreated
  if (record.state === IssueState.Pending) {
    deps.tracker.updateState(issue.number, IssueState.BranchCreated);
  }

  // 4. 安装依赖
  deps.emitProgress(issue.number, 'install', t('orchestrator.installProgress'));
  if (wtCtx.workspace) {
    await deps.installDependencies(wtCtx.workspace.primary.workDir);
  } else {
    await deps.installDependencies(wtCtx.workDir);
  }

  // 5. 初始化 PlanPersistence（在 primary repo）
  deps.emitProgress(issue.number, 'init_plan', t('orchestrator.initPlanProgress'));
  const primaryWorkDir = wtCtx.workspace ? wtCtx.workspace.primary.workDir : wtCtx.workDir;
  const primaryGitRoot = wtCtx.workspace ? wtCtx.workspace.primary.gitRootDir : wtCtx.gitRootDir;
  const wtGit = new GitOperations(primaryGitRoot);
  const wtPlan = new PlanPersistence(primaryWorkDir, issue.number);

  wtPlan.ensureDir();
  wtPlan.writeIssueMeta({
    id: issue.number,
    number: issue.number,
    title: issue.title,
    labels: issue.labels,
    state: issue.state,
  });

  // 合并 worktree 缺失期间收到的审核反馈后备（来自 reject-plan API 的兜底持久化）
  wtPlan.mergeBackupIfPresent();

  const existingProgress = wtPlan.readProgress();
  if (!existingProgress || record.state === IssueState.Pending) {
    wtPlan.writeProgress(
      wtPlan.createInitialProgress(issue.number, issue.title, branchName, pipelineDef),
    );
  }

  // 同步阶段进度到 tracker（处理旧记录无 phaseProgress 的情况）
  if (!record.phaseProgress) {
    deps.tracker.initPhaseProgress(issue.number, pipelineDef);
  }

  return { wtGit, wtPlan };
}
