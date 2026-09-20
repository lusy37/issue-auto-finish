import path from 'node:path';
import { runProcess } from '../utils/process.js';

import { logger as rootLogger } from '../logger.js';


const logger = rootLogger.child('GitOperations');

// 工作台当前运行目录不属于项目交付内容。
const REPOSITORY_CONTENT_PATHS = ['.', ':(exclude).iaf-mini'];

export class GitOperations {
  private workDir: string;

  constructor(workDir: string, private readonly signal?: AbortSignal) {
    this.workDir = workDir;
  }

  private async exec(args: string[]): Promise<string> {
    logger.debug('git exec', { args });
    const result = await runProcess('git', args, {
      cwd: this.workDir,
      env: { ...process.env, HUSKY: '0' },
      timeoutMs: 300000,
      signal: this.signal,
    });
    if (result.code !== 0) {
      const error = new Error(result.stderr.trim() || 'Git 命令失败');
      throw Object.assign(error, { code: result.code, stdout: result.stdout, stderr: result.stderr });
    }
    return result.stdout.trim();
  }

  async fetchAndPull(branch: string): Promise<void> {
    await this.exec(['fetch', 'origin']);
    await this.exec(['checkout', '-f', branch]);
    await this.exec(['pull', 'origin', branch]);
    logger.info('Fetched and pulled', { branch });
  }

  head(ref = 'HEAD'): Promise<string> { return this.exec(['rev-parse', '--verify', ref]); }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try { await this.exec(['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
  }
  async resetOwned(commit: string): Promise<void> { await this.exec(['reset', '--hard', commit]); }
  async changedContent(from: string, to = 'HEAD'): Promise<boolean> {
    return !!(await this.exec(['diff', '--name-only', from, to, '--', ...REPOSITORY_CONTENT_PATHS]));
  }
  async commitCandidate(message: string): Promise<string> {
    if (await this.hasChanges()) {
      await this.exec(['add', '-A', '--', ...REPOSITORY_CONTENT_PATHS]);
      const staged = await this.exec(['diff', '--cached', '--name-only']);
      if (staged) await this.commit(message);
    }
    return this.head();
  }
  async remoteHead(branch: string): Promise<string | undefined> {
    const output = await this.exec(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    return output.split(/\s+/)[0] || undefined;
  }
  async pushAccepted(branch: string, commit: string, lease?: string): Promise<void> {
    await this.exec(['push', '--no-verify', `--force-with-lease=refs/heads/${branch}:${lease ?? ''}`, 'origin', `${commit}:refs/heads/${branch}`]);
  }

  async fetch(): Promise<void> {
    await this.exec(['fetch', 'origin']);
    logger.info('Fetched from origin');
  }

  async createBranch(name: string, from: string): Promise<void> {
    // Create branch from origin/<from> without needing to checkout <from> first
    // Use -f to force checkout when untracked files conflict with the target
    await this.exec(['checkout', '-f', '-b', name, `origin/${from}`]);
    logger.info('Branch created', { name, from: `origin/${from}` });
  }

  async checkout(branch: string): Promise<void> {
    await this.exec(['checkout', '-f', branch]);
    logger.info('Checked out', { branch });
  }

  async add(files: string[]): Promise<void> {
    await this.exec(['add', ...files]);
  }

  async commit(message: string): Promise<void> {
    await this.exec(['commit', '--no-verify', '-m', message]);
    logger.info('Committed', { message: message.slice(0, 80) });
  }

  async push(branch: string): Promise<void> {
    await this.exec(['push', '--no-verify', '-u', 'origin', branch]);
    logger.info('Pushed', { branch });
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.exec(['rev-parse', '--verify', name]);
      return true;
    } catch {
      return false;
    }
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.exec(['rev-parse', '--verify', ref]);
      return true;
    } catch {
      return false;
    }
  }

  async remoteBranchExists(name: string): Promise<boolean> {
    try {
      await this.exec(['ls-remote', '--exit-code', '--heads', 'origin', name]);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    return this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async stash(): Promise<void> {
    await this.exec(['stash']);
  }

  async stashPop(): Promise<void> {
    await this.exec(['stash', 'pop']);
  }

  async hasChanges(): Promise<boolean> {
    const status = await this.exec(['status', '--porcelain']);
    return status.length > 0;
  }

  async addAndCommit(files: string[], message: string): Promise<void> {
    await this.add(files);
    await this.commit(message);
  }

  async fetchBranch(branch: string): Promise<void> {
    await this.exec(['fetch', 'origin', branch]);
    logger.info('Fetched specific branch', { branch });
  }

  async checkoutTrack(remoteBranch: string): Promise<void> {
    await this.fetchBranch(remoteBranch);
    await this.exec(['checkout', '-f', '-B', remoteBranch, 'FETCH_HEAD']);
    logger.info('Checked out remote branch via FETCH_HEAD', { remoteBranch });
  }

  async addCommitAndPush(files: string[], message: string, branch: string): Promise<void> {
    await this.add(files);
    await this.commit(message);
    await this.push(branch);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.exec(['branch', '-D', name]);
    logger.info('Branch deleted', { name });
  }

  async deleteRemoteBranch(name: string): Promise<void> {
    await this.exec(['push', 'origin', '--delete', name]);
    logger.info('Remote branch deleted', { name });
  }

  async worktreeAdd(dir: string, newBranch: string, startPoint: string): Promise<void> {
    await this.exec(['worktree', 'add', '-b', newBranch, dir, startPoint]);
    logger.info('Worktree added (new branch)', { dir, newBranch, startPoint });
  }

  async worktreeAddExisting(dir: string, branch: string): Promise<void> {
    await this.exec(['worktree', 'add', dir, branch]);
    logger.info('Worktree added (existing branch)', { dir, branch });
  }

  async worktreeAddTracking(dir: string, remoteBranch: string): Promise<void> {
    await this.exec(['worktree', 'add', '--track', '-b', remoteBranch, dir, `origin/${remoteBranch}`]);
    logger.info('Worktree added (tracking remote)', { dir, remoteBranch });
  }

  async worktreeRemove(dir: string, force = false): Promise<void> {
    const args = ['worktree', 'remove', dir];
    if (force) args.push('--force');
    await this.exec(args);
    logger.info('Worktree removed', { dir, force });
  }

  async worktreePrune(): Promise<void> {
    await this.exec(['worktree', 'prune']);
    logger.info('Worktree pruned stale entries');
  }

  async worktreeList(): Promise<string[]> {
    const output = await this.exec(['worktree', 'list', '--porcelain']);
    return output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.normalize(line.replace('worktree ', '').trim()));
  }

  async showFile(ref: string, filePath: string): Promise<string | null> {
    try {
      return await this.exec(['show', `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  async getConflictFiles(): Promise<string[]> {
    const output = await this.exec(['diff', '--name-only', '--diff-filter=U']);
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  }

  async rebase(targetRef: string): Promise<{ success: boolean; conflictFiles: string[] }> {
    try {
      await this.exec(['rebase', targetRef]);
      return { success: true, conflictFiles: [] };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('CONFLICT') || msg.includes('could not apply')) {
        const conflictFiles = await this.getConflictFiles();
        return { success: false, conflictFiles };
      }
      throw err;
    }
  }

  async rebaseContinue(): Promise<{ done: boolean; conflictFiles: string[] }> {
    try {
      await this.exec(['-c', 'core.editor=true', 'rebase', '--continue']);
      return { done: true, conflictFiles: [] };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('CONFLICT') || msg.includes('could not apply')) {
        const conflictFiles = await this.getConflictFiles();
        return { done: false, conflictFiles };
      }
      throw err;
    }
  }

  async rebaseAbort(): Promise<void> {
    await this.exec(['rebase', '--abort']);
    logger.info('Rebase aborted');
  }

  async isRebaseInProgress(): Promise<boolean> {
    const status = await this.exec(['status']);
    return status.includes('rebase in progress');
  }

  async forcePush(branch: string): Promise<void> {
    await this.exec(['push', '--no-verify', '--force-with-lease', '-u', 'origin', branch]);
    logger.info('Force pushed', { branch });
  }

  async mergeFF(branch: string): Promise<void> {
    await this.exec(['merge', '--ff-only', branch]);
    logger.info('Fast-forward merged', { branch });
  }

  async merge(branch: string, message: string): Promise<void> {
    await this.exec(['merge', '--no-ff', '--no-verify', '-m', message, branch]);
    logger.info('Merged', { branch, message: message.slice(0, 80) });
  }
}
