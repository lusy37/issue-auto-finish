import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IssueService } from '../../src/orchestrator/IssueService.js';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import { githubIssueToDemandSpec } from '../../src/demand/adapters/GitHubAdapter.js';
import type { WorktreeContext } from '../../src/git/WorktreeContext.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
import { createMockAIRunner, createMockGitHubClient, createMockGitOperations, createTestConfig, createTestIssue } from '../helpers/mock-factories.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-resources-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const config = createTestConfig();
  Object.assign(config.project, { gitRootDir: directory, worktreeBaseDir: path.join(directory, 'worktrees'), projectSubDir: '' });
  const tracker = new IssueTracker(path.join(directory, 'runtime'), PLAN_MODE_PIPELINE);
  const issue = createTestIssue({ number: 42 });
  tracker.create({ lifecycle: { kind: 'ready' }, branchName: 'iaf-42', demandSpec: githubIssueToDemandSpec(issue) });
  const github = createMockGitHubClient();
  const service = new IssueService(config, github as never, createMockGitOperations() as never, createMockAIRunner(), tracker);
  const workDir = service.getWorktreeStatus(42).path!;
  fs.mkdirSync(workDir, { recursive: true });
  const context: WorktreeContext = { issueIid: 42, branchName: 'iaf-42', gitRootDir: workDir, workDir };
  const ports = { backendPort: 4001, frontendPort: 9001 };
  const allocator = service.getPortAllocator();
  const allocate = vi.spyOn(allocator, 'allocate').mockResolvedValue(ports);
  const release = vi.spyOn(allocator, 'release');
  vi.spyOn(allocator, 'getPortsForIssue').mockReturnValue(ports);
  const manager = service.getDevServerManager();
  const start = vi.spyOn(manager, 'startServers').mockResolvedValue();
  vi.spyOn(manager, 'stopServers').mockImplementation(() => {});
  vi.spyOn(manager, 'waitForStopped').mockResolvedValue();
  const initial = service as unknown as {
    startPreviewServers(context: WorktreeContext, issue: GitHubIssue): Promise<unknown>;
  };
  const run = (entry: string) => entry === '首次启动'
    ? initial.startPreviewServers(context, issue)
    : service.restartPreview(42);
  return { tracker, github, context, ports, allocate, release, start, run };
}

it.each(['首次启动', '重启'])('%s 保存端口与时间，通知策略保持不变', async entry => {
  const f = setup();
  await f.run(entry);
  expect(f.allocate).toHaveBeenCalledExactlyOnceWith(42);
  expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ ports: f.ports }), f.ports, undefined);
  expect(f.tracker.get(42)?.ports).toEqual(f.ports);
  expect(f.tracker.get(42)?.previewStartedAt).toBeTruthy();
  if (entry === '首次启动') expect(f.github.createIssueNote).toHaveBeenCalledOnce();
  else expect(f.github.createIssueNote).not.toHaveBeenCalled();
});

it.each(['首次启动', '重启'])('%s 启动失败时统一回滚资源，保留各自的错误策略', async entry => {
  const f = setup();
  f.start.mockRejectedValueOnce(new Error('启动失败'));
  if (entry === '首次启动') {
    expect(await f.run(entry)).toBeNull();
    expect(f.github.createIssueNote).toHaveBeenCalledWith(42, expect.stringContaining('启动失败'));
  } else {
    await expect(f.run(entry)).rejects.toThrow('启动失败');
    expect(f.github.createIssueNote).not.toHaveBeenCalled();
  }
  expect(f.release).toHaveBeenLastCalledWith(42);
  expect(f.tracker.get(42)?.ports).toBeUndefined();
  expect(f.tracker.get(42)?.previewStartedAt).toBeUndefined();
  if (entry === '首次启动') expect(f.context.ports).toBeUndefined();
});

it.each(['首次启动', '重启'])('%s 分配失败时不启动服务', async entry => {
  const f = setup();
  f.allocate.mockRejectedValueOnce(new Error('端口不足'));
  if (entry === '首次启动') expect(await f.run(entry)).toBeNull();
  else await expect(f.run(entry)).rejects.toThrow('端口不足');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.tracker.get(42)?.ports).toBeUndefined();
});
