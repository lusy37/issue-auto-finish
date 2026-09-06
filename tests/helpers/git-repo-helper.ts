import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GitFixture {
  bareDir: string;
  cloneDir: string;
  cleanup: () => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

export function createFixture(): GitFixture {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
  const bareDir = path.join(tmpRoot, 'bare.git');
  const cloneDir = path.join(tmpRoot, 'clone');

  // Create bare repo
  fs.mkdirSync(bareDir);
  git(bareDir, ['init', '--bare']);

  // Clone it
  git(tmpRoot, ['clone', bareDir, 'clone']);

  // Configure user for commits
  git(cloneDir, ['config', 'user.email', 'test@test.com']);
  git(cloneDir, ['config', 'user.name', 'Test']);

  // Create initial commit and push
  const readmePath = path.join(cloneDir, 'README.md');
  fs.writeFileSync(readmePath, '# Test Repo\n');
  git(cloneDir, ['add', 'README.md']);
  git(cloneDir, ['commit', '-m', 'Initial commit']);
  git(cloneDir, ['push', 'origin', 'master']);

  return {
    bareDir,
    cloneDir,
    cleanup: () => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

export function createRemoteOnlyBranch(_bareDir: string, cloneDir: string, branchName: string): void {
  // Create the branch in clone, push it, then delete local branch
  git(cloneDir, ['checkout', '-b', branchName]);
  const markerPath = path.join(cloneDir, `${branchName}-marker.txt`);
  fs.writeFileSync(markerPath, `marker for ${branchName}\n`);
  git(cloneDir, ['add', '.']);
  git(cloneDir, ['commit', '-m', `Add marker for ${branchName}`]);
  git(cloneDir, ['push', 'origin', branchName]);
  git(cloneDir, ['checkout', 'master']);
  git(cloneDir, ['branch', '-D', branchName]);
}
