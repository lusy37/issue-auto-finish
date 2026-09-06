import type { ProjectConfig } from '../config.js';
export interface RepoConfig { name: string; repository: string; localGitRoot: string; projectSubDir: string; baseBranch?: string; branchPrefix?: string; role: string }
export interface WorkspaceConfig { primary: RepoConfig }
export function buildSingleRepoWorkspace(project: ProjectConfig, repository: string): WorkspaceConfig {
 return { primary: { name: 'primary', repository, localGitRoot: project.gitRootDir, projectSubDir: project.projectSubDir, baseBranch: project.baseBranch, branchPrefix: project.branchPrefix, role: '' } };
}
