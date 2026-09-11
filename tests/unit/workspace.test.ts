import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadWorkspaceConfig,
  buildSingleRepoWorkspace,
  getAllRepos,
  isMultiRepo,
} from '../../src/workspace/WorkspaceConfig.js';
import type { WorkspaceConfig } from '../../src/workspace/WorkspaceConfig.js';
import { buildWorkspaceSection } from '../../src/prompts/templates.js';
import type { WorkspaceLayout } from '../../src/prompts/templates.js';

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
