import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitOperations } from '../../src/git/GitOperations.js';
import { createFixture, createRemoteOnlyBranch, GitFixture } from '../helpers/git-repo-helper.js';

describe('GitOperations — worktree methods', () => {
  let fixture: GitFixture;
  let git: GitOperations;

  beforeEach(() => {
    fixture = createFixture();
    git = new GitOperations(fixture.cloneDir);
  }, 30000);

  afterEach(() => {
    fixture.cleanup();
  });

  it('worktreeAdd creates a worktree with a new branch', async () => {
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-new');
    await git.worktreeAdd(wtDir, 'feat-test', 'origin/master');

    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, 'README.md'))).toBe(true);

    // Verify the branch was created
    const wtGit = new GitOperations(wtDir);
    const branch = await wtGit.getCurrentBranch();
    expect(branch).toBe('feat-test');
  });

  it('worktreeAddExisting reuses an existing local branch', async () => {
    // First create a worktree with a branch, then remove the worktree (keeping the branch)
    const tmpWtDir = path.join(path.dirname(fixture.cloneDir), 'wt-tmp');
    await git.worktreeAdd(tmpWtDir, 'existing-branch', 'origin/master');

    // Write a file in the worktree to verify branch content
    const wtGit = new GitOperations(tmpWtDir);
    fs.writeFileSync(path.join(tmpWtDir, 'marker.txt'), 'exists');
    await wtGit.add(['marker.txt']);
    await wtGit.commit('add marker');

    // Remove worktree but keep branch
    await git.worktreeRemove(tmpWtDir);

    // Now re-add using existing branch
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-reuse');
    await git.worktreeAddExisting(wtDir, 'existing-branch');

    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, 'marker.txt'))).toBe(true);
  });

  it('worktreeAddTracking creates a worktree tracking a remote branch', async () => {
    createRemoteOnlyBranch(fixture.bareDir, fixture.cloneDir, 'remote-only');

    // Fetch to see the remote branch
    await git.fetch();

    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-track');
    await git.worktreeAddTracking(wtDir, 'remote-only');

    expect(fs.existsSync(wtDir)).toBe(true);
    expect(fs.existsSync(path.join(wtDir, 'remote-only-marker.txt'))).toBe(true);

    const wtGit = new GitOperations(wtDir);
    const branch = await wtGit.getCurrentBranch();
    expect(branch).toBe('remote-only');
  });

  it('worktreeRemove deletes an existing worktree', async () => {
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-remove');
    await git.worktreeAdd(wtDir, 'remove-test', 'origin/master');
    expect(fs.existsSync(wtDir)).toBe(true);

    await git.worktreeRemove(wtDir);
    expect(fs.existsSync(wtDir)).toBe(false);
  });

  it('worktreeRemove with force removes a dirty worktree', async () => {
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-force');
    await git.worktreeAdd(wtDir, 'force-test', 'origin/master');

    // Make the worktree dirty
    fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'uncommitted');

    await git.worktreeRemove(wtDir, true);
    expect(fs.existsSync(wtDir)).toBe(false);
  });

  it('worktreeList returns all worktrees', async () => {
    const wt1 = path.join(path.dirname(fixture.cloneDir), 'wt-list-1');
    const wt2 = path.join(path.dirname(fixture.cloneDir), 'wt-list-2');

    await git.worktreeAdd(wt1, 'list-1', 'origin/master');
    await git.worktreeAdd(wt2, 'list-2', 'origin/master');

    const list = await git.worktreeList();

    // Should include main repo + 2 worktrees
    expect(list.map(p=>fs.realpathSync.native(p).toLowerCase())).toContain(fs.realpathSync.native(fixture.cloneDir).toLowerCase());
    expect(list.map(p=>fs.realpathSync.native(p).toLowerCase())).toContain(fs.realpathSync.native(wt1).toLowerCase());
    expect(list.map(p=>fs.realpathSync.native(p).toLowerCase())).toContain(fs.realpathSync.native(wt2).toLowerCase());
    expect(list.length).toBe(3);
  });

  it('concurrent worktrees are isolated from each other', async () => {
    const wt1 = path.join(path.dirname(fixture.cloneDir), 'wt-iso-1');
    const wt2 = path.join(path.dirname(fixture.cloneDir), 'wt-iso-2');

    await git.worktreeAdd(wt1, 'iso-1', 'origin/master');
    await git.worktreeAdd(wt2, 'iso-2', 'origin/master');

    const git1 = new GitOperations(wt1);
    const git2 = new GitOperations(wt2);

    // Write different files in each worktree
    fs.writeFileSync(path.join(wt1, 'file1.txt'), 'from wt1');
    await git1.add(['file1.txt']);
    await git1.commit('wt1 commit');

    fs.writeFileSync(path.join(wt2, 'file2.txt'), 'from wt2');
    await git2.add(['file2.txt']);
    await git2.commit('wt2 commit');

    // Verify isolation
    expect(fs.existsSync(path.join(wt1, 'file1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt1, 'file2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt2, 'file2.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt2, 'file1.txt'))).toBe(false);
  });

  it('full lifecycle: add → list → use → remove', async () => {
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-lifecycle');

    // Add
    await git.worktreeAdd(wtDir, 'lifecycle-test', 'origin/master');
    expect(fs.existsSync(wtDir)).toBe(true);

    // List
    const list = await git.worktreeList();
    expect(list.map(p=>fs.realpathSync.native(p).toLowerCase())).toContain(fs.realpathSync.native(wtDir).toLowerCase());

    // Use: commit a file in the worktree
    const wtGit = new GitOperations(wtDir);
    fs.writeFileSync(path.join(wtDir, 'lifecycle.txt'), 'lifecycle');
    await wtGit.add(['lifecycle.txt']);
    await wtGit.commit('lifecycle commit');

    const branch = await wtGit.getCurrentBranch();
    expect(branch).toBe('lifecycle-test');

    // Remove
    await git.worktreeRemove(wtDir);
    expect(fs.existsSync(wtDir)).toBe(false);

    // Verify list no longer includes it
    const listAfter = await git.worktreeList();
    expect(listAfter).not.toContain(wtDir);
  });

  it('showFile reads a committed file from a branch', async () => {
    const wtDir = path.join(path.dirname(fixture.cloneDir), 'wt-show');
    await git.worktreeAdd(wtDir, 'show-test', 'origin/master');

    const wtGit = new GitOperations(wtDir);
    fs.writeFileSync(path.join(wtDir, 'data.txt'), 'hello from show');
    await wtGit.add(['data.txt']);
    await wtGit.commit('add data');

    // Read from main repo using branch name
    const content = await git.showFile('show-test', 'data.txt');
    expect(content).toBe('hello from show');
  });

  it('showFile returns null for non-existent file', async () => {
    const content = await git.showFile('master', 'no-such-file.txt');
    expect(content).toBeNull();
  });

  it('showFile returns null for non-existent branch', async () => {
    const content = await git.showFile('no-such-branch', 'README.md');
    expect(content).toBeNull();
  });
});
