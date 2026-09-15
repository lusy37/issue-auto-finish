import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../src/utils/process.js';
import { envSchema, transformEnvToConfig } from '../../src/config-schema.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { buildPlanModePipeline, createLifecycleManager } from '../../src/pipeline/PipelineMetadata.js';
import { IssueService } from '../../src/orchestrator/IssueService.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { GitHubClient, type GitHubPullRequest } from '../../src/clients/GitHubClient.js';
import { createTestIssue } from '../helpers/mock-factories.js';
import type { AIRunner } from '../../src/ai-runner/AIRunner.js';
import * as browser from '../../src/e2e/PlaywrightRunner.js';

let directory: string;
beforeEach(() => { const base = path.resolve('.iaf-mini/test-e2e-disabled'); fs.mkdirSync(base, { recursive: true }); directory = fs.mkdtempSync(path.join(base, 'repository-')); vi.stubEnv('DATA_DIR', path.join(directory, 'runtime')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30000 });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// Git、计划审核、落盘、阶段执行和交付均使用实际实现；仅 AI 与 GitHub 响应模拟。
it('无浏览器配置的仓库关闭 E2E 后，经审核重启仍可完成 verify 并交付', async () => {
  const repo = path.join(directory, 'repository'), origin = path.join(directory, 'origin.git');
  fs.mkdirSync(repo);
  await git(directory, 'init', '--bare', origin);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', '验收测试'); await git(repo, 'config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# 无浏览器依赖的测试仓库\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', '初始化');
  await git(repo, 'remote', 'add', 'origin', origin); await git(repo, 'push', '-u', 'origin', 'main');
  const config = transformEnvToConfig(envSchema.parse({ GITHUB_TOKEN: 'mock', GITHUB_REPOSITORY: 'test/project', PROJECT_WORK_DIR: repo, BASE_BRANCH: 'main', WORKTREE_BASE_DIR: path.join(directory, 'worktrees'), E2E_UI_ENABLED: 'false', PREVIEW_ENABLED: 'false', ISSUE_NOTE_SYNC_ENABLED: 'false' }), directory);
  const definition = buildPlanModePipeline({ e2eEnabled: false });
  const managers = new Map([[definition.mode, createLifecycleManager(definition)]]);
  const tracker = new IssueTracker(process.env.DATA_DIR!, managers);
  const platform = new GitHubClient(config.github);
  const issue = createTestIssue({ number: 1, title: '实现计算函数', labels: ['auto-finish'] });
  vi.spyOn(platform, 'updateIssueLabels').mockResolvedValue(undefined);
  vi.spyOn(platform, 'listIssueNotes').mockResolvedValue([]);
  const note = vi.spyOn(platform, 'createIssueNote').mockResolvedValue(undefined);
  vi.spyOn(platform, 'findPullRequestByBranch').mockResolvedValue(null);
  vi.spyOn(platform, 'listPullRequests').mockResolvedValue([]);
  let pullRequest: GitHubPullRequest;
  const create = vi.spyOn(platform, 'createPullRequest').mockImplementation(async options => {
    pullRequest = { id: 1, number: 1, state: 'open', title: options.title, description: options.description, html_url: 'https://example.test/pr/1', source_branch: options.sourceBranch, target_branch: options.targetBranch, source_repository: 'test/project', target_repository: 'test/project' };
    return pullRequest;
  });
  vi.spyOn(platform, 'getPullRequestDetail').mockRejectedValue(new Error('首次交付不应读取已有 PR 详情'));
  const uat = vi.spyOn(browser, 'executeUat').mockRejectedValue(new Error('关闭时不应调用浏览器'));
  const calls: string[] = [];
  const plan = JSON.stringify({ title: '实现纯函数', description: '无需浏览器的需求', acceptanceCriteria: ['计算正确'], tasks: [{ id: 'calculation', title: '实现计算', instructions: '增加 counter.mjs 并覆盖计算行为', acceptanceCriteria: ['计算正确'], dependsOn: [] }] });
  const report = '# 验证报告\n\n**Lint 结果**: 通过\n**Build 结果**: 通过\n**Test 结果**: 通过\n\n## 总结\n代码检查与关联测试全部通过，计算结果符合本次实施计划。\n';
  const runner: AIRunner = { killAll() {}, killByWorkDir() { return 0; }, async run(options) {
    calls.push(options.phaseName ?? 'plan');
    if (options.mode === 'plan') return { success: true, exitCode: 0, output: plan };

    if (options.phaseName === 'build') {
      fs.writeFileSync(path.join(options.workDir, 'counter.mjs'), 'export const negate = value => -value;\n');

      return { success: true, exitCode: 0, output: '计算函数已实现' };
    }
    if (options.phaseName === 'verify') {  return { success: true, exitCode: 0, output: report }; }
    throw new Error('不应出现的 AI 阶段：' + options.phaseName);
  } };
  const service = new IssueService(config, platform, new GitOperations(repo), runner, tracker);
  await service.processIssue(issue);
  expect(tracker.get(1)?.state).toBe(IssueState.PhaseWaiting);
  expect(Object.hasOwn(tracker.get(1)!.phaseProgress!, 'uat')).toBe(false);
  config.e2e.enabled = true;
  const restored = new IssueTracker(process.env.DATA_DIR!, managers);
  const resumed = new IssueService(config, platform, new GitOperations(repo), runner, restored);
  await resumed.applyGateAction(1, { action: 'approve' }, restored.get(1)!.run!.planRevision);
  await resumed.processIssue(issue);
  expect(restored.get(1)?.state).toBe(IssueState.Completed);
  expect(restored.get(1)?.phaseProgress?.verify?.status).toBe('completed');
  expect(restored.get(1)?.phaseProgress?.uat).toBeUndefined();
  expect(uat).not.toHaveBeenCalled();
  expect(calls).toEqual(['plan', 'build', 'verify']);
  expect(create).toHaveBeenCalledTimes(1);
  expect(note).toHaveBeenCalledWith(1, expect.stringContaining('浏览器验收未启用'));
  const record = restored.get(1)!;
  const workspace = path.join(config.project.worktreeBaseDir, 'issue-1');
  expect(fs.existsSync(path.join(workspace, config.e2e.configFile))).toBe(false);
  expect(await git(repo, 'ls-remote', 'origin', 'refs/heads/' + record.branchName)).toContain(await git(workspace, 'rev-parse', 'HEAD'));
}, 180000);
