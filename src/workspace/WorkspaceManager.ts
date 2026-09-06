import type {RepoContext,WorkspaceContext} from './WorkspaceTypes.js';
export type {RepoContext,WorkspaceContext} from './WorkspaceTypes.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { GitOperations } from '../git/GitOperations.js';
import type { WorkspaceConfig } from './WorkspaceConfig.js';
import { logger as rootLogger } from '../logger.js';
import { InvalidStateError } from '../errors/InvalidOperationError.js';

const logger = rootLogger.child('WorkspaceManager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-repo runtime context within an issue workspace. */


/** Full workspace context for an issue — replaces the old single WorktreeContext. */


// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private wsConfig: WorkspaceConfig;
  private worktreeBaseDir: string;
  private mainGit: GitOperations;

  constructor(opts: {
    wsConfig: WorkspaceConfig;
    worktreeBaseDir: string;
    mainGit: GitOperations;
  }) {
    this.wsConfig = opts.wsConfig;
    this.worktreeBaseDir = opts.worktreeBaseDir;
    this.mainGit = opts.mainGit;
  }

  // ── Workspace lifecycle ──

  /**
   * Prepare the full workspace for an issue:
   * - Create the workspace root directory.
   * - For the primary repo: create a git worktree.
   */
  async prepareWorkspace(
    issueIid: number,
    branchName: string,
    globalBaseBranch: string,
  ): Promise<WorkspaceContext> {
    const wsRoot = this.getWorkspaceRoot(issueIid);
    await fs.mkdir(wsRoot, { recursive: true });

    const primaryCtx = this.buildPrimaryContext(issueIid, globalBaseBranch);
    await this.ensurePrimaryWorktree(primaryCtx.gitRootDir, branchName, primaryCtx.baseBranch);
    logger.info('Workspace prepared', {
      issueIid,
      wsRoot,
      repository: primaryCtx.name,
    });

    return {
      issueIid,
      branchName,
      workspaceRoot: wsRoot,
      primary: primaryCtx,
    };
  }

  /**
   */
  async cleanupWorkspace(wsCtx: WorkspaceContext): Promise<void> {
    // Clean primary worktree
    try {
      await this.mainGit.worktreeRemove(wsCtx.primary.gitRootDir, true);
      logger.info('Primary worktree removed', { dir: wsCtx.primary.gitRootDir });
    } catch (err) {
      logger.warn('Failed to remove primary worktree', {
        dir: wsCtx.primary.gitRootDir,
        error: (err as Error).message,
      });
    }

    // Remove workspace root if empty
    try {
      const entries = await fs.readdir(wsCtx.workspaceRoot);
      if (entries.length === 0) {
        await fs.rmdir(wsCtx.workspaceRoot);
      }
    } catch { /* ignore */ }
  }

  /** 从配置重建单仓库的工作区信息，供创建与恢复工作区共用。 */
  buildPrimaryContext(issueIid: number, globalBaseBranch: string, globalBranchPrefix?: string): RepoContext {
    const wsRoot = this.getWorkspaceRoot(issueIid);
    const primary = this.wsConfig.primary;
    const defaultPrefix = globalBranchPrefix ?? primary.branchPrefix ?? 'feat/issue';
    const primaryDir = wsRoot;
    return {
      name: primary.name,
      repository: primary.repository,
      role: primary.role ?? '',
      gitRootDir: primaryDir,
      workDir: path.join(primaryDir, primary.projectSubDir ?? ''),
      baseBranch: primary.baseBranch ?? globalBaseBranch,
      branchPrefix: primary.branchPrefix ?? defaultPrefix,
      isPrimary: true,
    };
  }

  getWorkspaceRoot(issueIid: number): string {
    if (!Number.isSafeInteger(issueIid) || issueIid <= 0) throw new Error('Issue 编号必须为正整数');
    return path.join(this.worktreeBaseDir, `issue-${issueIid}`);
  }

  // ── Internal helpers ──

  private async ensurePrimaryWorktree(
    repoDir: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void> {


    const worktrees = await this.mainGit.worktreeList();

    if (worktrees.some(dir => path.resolve(dir).toLowerCase() === path.resolve(repoDir).toLowerCase())) {
      try {
        await fs.access(path.join(repoDir, '.git'));
        logger.info('Reusing existing primary worktree', { dir: repoDir });
        return;
      } catch {
        logger.warn('Primary worktree registered but .git missing, recreating', { dir: repoDir });
        await this.mainGit.worktreeRemove(repoDir, true);
        await this.mainGit.worktreePrune();
      }
    }

    await this.cleanStaleDir(repoDir);

    const localExists = await this.mainGit.branchExists(branchName);
    if (localExists) {
      await this.mainGit.worktreeAddExisting(repoDir, branchName);
      return;
    }

    const remoteExists = await this.mainGit.remoteBranchExists(branchName);
    if (remoteExists) {
      await this.mainGit.worktreeAddTracking(repoDir, branchName);
      return;
    }

    await this.ensureBaseBranchRef(baseBranch);
    await this.mainGit.worktreeAdd(repoDir, branchName, `origin/${baseBranch}`);
  }

  private async ensureBaseBranchRef(baseBranch: string, git: GitOperations = this.mainGit): Promise<void> {
    const remoteRef = `origin/${baseBranch}`;
    if (await git.refExists(remoteRef)) return;

    logger.warn('Base branch ref missing after fetch, attempting targeted fetch', { remoteRef });
    try {
      await git.fetchBranch(baseBranch);
    } catch {
      // targeted fetch failed — remote branch likely does not exist
    }

    if (!(await git.refExists(remoteRef))) {
      throw new InvalidStateError(
        `基准分支 ${remoteRef} 不存在。请检查 BASE_BRANCH 配置（当前值: "${baseBranch}"），` +
        `确认远端仓库存在该分支，或执行 git fetch origin`,
      );
    }
    logger.info('Base branch ref recovered via targeted fetch', { remoteRef });
  }
private async cleanStaleDir(dir: string): Promise<void> {
 const relative=path.relative(path.resolve(this.worktreeBaseDir),path.resolve(dir));
 if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('工作区路径越界');
 if(await this.dirExists(dir)) { const entries=await fs.readdir(dir); if(entries.length) throw new Error('工作区目录存在未登记文件，请手动核对：'+dir); await fs.rmdir(dir); }
}

  private async dirExists(dir: string): Promise<boolean> {
    try {
      await fs.access(dir);
      return true;
    } catch {
      return false;
    }
  }
}
