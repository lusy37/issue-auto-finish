/** 工作区数据契约，供提示词与工作区管理共用。 */
export interface RepoContext {
  name: string;
  repository: string;
  role: string;
  /** Absolute path: the git root for this repo within the issue workspace. */
  gitRootDir: string;
  /** Absolute path: the project sub-directory (AI cwd when single-repo). */
  workDir: string;
  /** The repo's base branch. */
  baseBranch: string;
  /** Branch prefix for this repo (e.g. "feat/issue"). */
  branchPrefix: string;
  /** Whether this is the primary repository. */
  isPrimary: boolean;
}

export interface WorkspaceContext {
  /** Issue IID this workspace belongs to. */
  issueIid: number;
  /** The branch name used across all repos. */
  branchName: string;
  /** Root directory of the workspace: WORKTREE_BASE_DIR/issue-{number}/ */
  workspaceRoot: string;
  /** Primary repo context. */
  primary: RepoContext;
}
