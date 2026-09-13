import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { graphFixture, graphDeps, git, task } from '../helpers/dag-repository.js';
import { createMockOrchestratorDeps, createTestConfig } from '../helpers/mock-factories.js';
import { TaskGraphExecutor } from '../../src/dag/TaskGraphExecutor.js';
import { deliverIssue } from '../../src/dag/DeliveryService.js';
import type { IssueProcessingContext } from '../../src/orchestrator/IssueProcessingContext.js';
import type { GitHubPullRequest } from '../../src/clients/GitHubClient.js';
import type { AIRunner } from '../../src/ai-runner/AIRunner.js';
import { IssueState } from '../../src/tracker/IssueState.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
async function prepared() {
  const f = graphFixture([task('a')]); directories.push(f.directory);
  const origin = path.join(f.directory, 'origin.git'); git(f.directory, 'init', '--bare', origin); git(f.repo, 'remote', 'add', 'origin', origin); git(f.repo, 'push', 'origin', 'main');
  let content = '第一轮';
  const runner: AIRunner = { killAll() {}, killByWorkDir: () => 0, async run(options) { fs.writeFileSync(path.join(options.workDir, 'result.txt'), content); return { success: true, exitCode: 0, output: '执行完成' }; } };
  const accept = async () => {
    await new TaskGraphExecutor(graphDeps(f, runner)).execute();
    const commit = git(f.integration, 'rev-parse', 'HEAD');
    f.tracker.transaction(1, record => { record.run!.candidateCommit = commit; record.run!.verify = { commit, completedAt: new Date().toISOString(), passed: true, reportPath: path.join(f.data, 'verify.md') }; record.run!.uat = { ...record.run!.verify, reportPath: path.join(f.data, 'uat.json'), runId: 'current-uat' }; });
    return commit;
  };
  await accept();
  const config = createTestConfig(); Object.assign(config.project, { gitRootDir: f.repo, workDir: f.integration, baseBranch: 'main', worktreeBaseDir: f.worktrees, projectSubDir: '' });
  const deps = createMockOrchestratorDeps({ tracker: f.tracker, config });
  let platformPr: GitHubPullRequest | undefined;
  const list = vi.fn(async () => platformPr ? [platformPr] : []);
  const create = vi.fn(async (options: any) => {
    platformPr = { id: 8, number: 8, title: '需求', state: 'open', html_url: 'https://github.com/test/project/pull/8', description: options.description, source_branch: options.sourceBranch, target_branch: options.targetBranch, source_repository: 'test/project', target_repository: 'test/project' };
    return platformPr;
  });
  deps.github.listPullRequests = list; deps.github.createPullRequest = create;
  deps.github.getPullRequestDetail = vi.fn(async () => platformPr!);
  const ctx = { issue: { number: 1 }, demand: f.tracker.get(1)!.demandSpec!, branchName: 'iaf-1', wtCtx: { gitRootDir: f.integration, workDir: f.integration } } as IssueProcessingContext;
  return { ...f, deps, ctx, create, list, accept, pr: () => platformPr!, deliver: () => deliverIssue(ctx, deps), setContent: (value: string) => { content = value; } };
}
describe('验收提交与唯一 PR 交付', { timeout: 300_000 }, () => {
  it('创建响应丢失后只查询关联原 PR，不重复 POST', async () => {
    const f = await prepared(); const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async options => { await create(options); throw new Error('响应丢失'); });
    await expect(f.deliver()).rejects.toThrow('响应丢失');
    expect(f.tracker.get(1)!.run!.delivery!.creation).toBe('unknown');
    await f.deliver(); await f.deliver();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.tracker.get(1)!.run!.delivery!.prNumber).toBe(8);
    expect(f.deps.github.createIssueNote).toHaveBeenCalledTimes(1);
  });
  it('未知创建后即使平台空查询也不重新创建', async () => {
    const f = await prepared(); f.create.mockRejectedValue(new Error('网络断开'));
    await expect(f.deliver()).rejects.toThrow(); await expect(f.deliver()).rejects.toThrow('仍未知');
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it.each(['head', 'dirty'])('验收后的 %s 变化拒绝推送和 PR 创建', async change => {
    const f = await prepared(); fs.writeFileSync(path.join(f.integration, 'unreviewed.txt'), '未验收');
    if (change === 'head') { git(f.integration, 'add', '.'); git(f.integration, 'commit', '-m', '验收外变更'); }
    await expect(f.deliver()).rejects.toThrow('改变'); expect(f.create).not.toHaveBeenCalled();
    expect(git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/iaf-1')).toBe('');
  });
  it('完整重做使用新预算，但继续更新同一个开放 PR', async () => {
    const f = await prepared(); await f.deliver(); const oldRemote = f.tracker.get(1)!.run!.delivery!.remoteCommit;
    f.tracker.resetFull(1); git(f.integration, 'reset', '--hard', 'main');
    f.tracker.store.savePlan(1, { title: '第二轮', description: '完整重做', acceptanceCriteria: ['通过'], tasks: [task('a')] }, f.tracker.get(1)!.run!.version);
    f.tracker.transaction(1, record => { record.state = IssueState.PhaseRunning; record.currentPhase = 'build'; record.run!.dispatchId = 'redo'; record.run!.review!.decision = 'approved'; });
    f.setContent('第二轮'); await f.accept(); await f.deliver();
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.tracker.get(1)!.run!.delivery!.prNumber).toBe(8);
    expect(f.tracker.get(1)!.run!.delivery!.remoteCommit).not.toBe(oldRemote);
    expect(git(f.repo, 'show', 'origin/iaf-1:result.txt')).toBe('第二轮');
  });
  it.each(['closed', 'merged'] as const)('原 PR 为 %s 时拒绝重新交付', async state => {
    const f = await prepared(); await f.deliver(); f.pr().state = state;
    await expect(f.deliver()).rejects.toThrow(state === 'closed' ? '重开' : '新建'); expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('远端未记录的更新不被 lease 推送覆盖', async () => {
    const f = await prepared(); await f.deliver();
    fs.writeFileSync(path.join(f.repo, 'human.txt'), '人工变更'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', '人工变更');
    git(f.repo, 'push', '--force', 'origin', 'HEAD:refs/heads/iaf-1'); const human = git(f.repo, 'rev-parse', 'HEAD');
    await expect(f.deliver()).rejects.toThrow('未记录'); expect(git(f.repo, 'ls-remote', 'origin', 'refs/heads/iaf-1')).toContain(human);
  });
  it('标记匹配但仓库或分支不匹配不能关联', async () => {
    const f = await prepared(); await f.deliver(); f.pr().source_repository = 'other/repository';
    await expect(f.deliver()).rejects.toThrow('不匹配'); expect(f.create).toHaveBeenCalledTimes(1);
  });
});

it('Issue 回写响应丢失后保持未知，查到稳定标记后补齐进度而不重发', async () => {
  const f = await prepared();
  let posted = '';
  const post = vi.fn(async (_number: number, body: string) => { posted = body; throw new Error('回写响应丢失'); });
  f.deps.github.createIssueNote = post;
  f.deps.github.listIssueNotes = vi.fn().mockResolvedValue([]);
  await expect(f.deliver()).rejects.toThrow('回写响应丢失');
  expect(f.tracker.get(1)!.run!.delivery!.issueWriteIntent?.commit).toBeTruthy();
  await expect(f.deliver()).rejects.toThrow('回写结果仍未知');
  f.deps.github.listIssueNotes = vi.fn().mockResolvedValue([{ body: posted }]);
  await f.deliver();
  expect(post).toHaveBeenCalledTimes(1);
  expect(f.tracker.get(1)!.run!.delivery!.issueWriteIntent).toBeUndefined();
  expect(f.tracker.get(1)!.run!.delivery!.issueWrittenCommit).toBe(f.tracker.get(1)!.run!.candidateCommit);
});
