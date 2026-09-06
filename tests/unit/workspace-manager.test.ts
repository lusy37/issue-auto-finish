import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceManager } from '../../src/workspace/WorkspaceManager.js';
import { buildSingleRepoWorkspace } from '../../src/workspace/WorkspaceConfig.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { InvalidStateError } from '../../src/errors/InvalidOperationError.js';
import { createFixture, type GitFixture } from '../helpers/git-repo-helper.js';

describe('WorkspaceManager — baseBranch validation', () => {
  let fixture: GitFixture;
  let mainGit: GitOperations;
  let worktreeBaseDir: string;

  beforeEach(() => {
    fixture = createFixture();
    mainGit = new GitOperations(fixture.cloneDir);
    worktreeBaseDir = path.join(path.dirname(fixture.cloneDir), 'worktrees');
    fs.mkdirSync(worktreeBaseDir, { recursive: true });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function createManager(baseBranch: string): WorkspaceManager {
    const wsConfig = buildSingleRepoWorkspace(
      {
        workDir: fixture.cloneDir,
        gitRootDir: fixture.cloneDir,
        projectSubDir: '',
        baseBranch,
        branchPrefix: 'feat/issue',
      },
      'test/project',
    );
    return new WorkspaceManager({
      wsConfig,
      worktreeBaseDir,
      mainGit,
    });
  }

  it('creates worktree successfully when baseBranch exists', async () => {
    const manager = createManager('master');
    const ctx = await manager.prepareWorkspace(1, 'feat/issue-1', 'master');

    expect(ctx.primary.gitRootDir).toContain('issue-1');
    expect(fs.existsSync(ctx.primary.gitRootDir)).toBe(true);
  });

  it('throws InvalidStateError when baseBranch does not exist on remote', async () => {
    const manager = createManager('nonexistent-branch');

    await expect(
      manager.prepareWorkspace(2, 'feat/issue-2', 'nonexistent-branch'),
    ).rejects.toThrow(InvalidStateError);
  });

  it('error message includes the misconfigured branch name', async () => {
    const manager = createManager('develop');

    await expect(
      manager.prepareWorkspace(3, 'feat/issue-3', 'develop'),
    ).rejects.toThrow(/develop/);
  });

  it('refExists returns true for valid refs and false for invalid', async () => {
    expect(await mainGit.refExists('origin/master')).toBe(true);
    expect(await mainGit.refExists('origin/nonexistent')).toBe(false);
    expect(await mainGit.refExists('master')).toBe(true);
  });
});
