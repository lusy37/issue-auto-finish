import { describe, it, expect } from 'vitest';
import { buildSingleRepoWorkspace } from '../../src/workspace/WorkspaceConfig.js';

describe('buildSingleRepoWorkspace', () => {
  it('creates workspace config from project settings', () => {
    const ws = buildSingleRepoWorkspace(
      {
        workDir: '/data/project/app/svc',
        gitRootDir: '/data/project',
        projectSubDir: 'app/svc',
        baseBranch: 'master',
        branchPrefix: 'feat/issue',
      },
      'team/project',
    );

    expect(ws.primary.name).toBe('primary');
    expect(ws.primary.repository).toBe('team/project');
    expect(ws.primary.localGitRoot).toBe('/data/project');
    expect(ws.primary.projectSubDir).toBe('app/svc');
    expect(ws.primary.baseBranch).toBe('master');
    expect(ws).not.toHaveProperty("associates");
  });
});
