import type { PortPair } from '../preview/PortAllocator.js';
import type { WorkspaceContext } from '../workspace/index.js';

export interface WorktreeContext {
  gitRootDir: string;
  workDir: string;
  branchName: string;
  issueIid: number;
  ports?: PortPair;
  workspace?: WorkspaceContext;
}
