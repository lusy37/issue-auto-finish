import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IssueTracker } from '../../src/tracker/IssueTracker.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineMetadata.js';
import type { PipelineDef } from '../../src/pipeline/PipelineMetadata.js';
import type { TaskDefinition } from '../../src/dag/contracts.js';
import { GitOperations } from '../../src/git/GitOperations.js';
import { AsyncMutex } from '../../src/utils/AsyncMutex.js';
import type { GraphDependencies } from '../../src/dag/TaskGraphExecutor.js';
import type { AIRunner } from '../../src/ai-runner/AIRunner.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
}
export const task = (id: string, dependsOn: string[] = []): TaskDefinition => ({ id, dependsOn, title: id, instructions: `实现 ${id}`, acceptanceCriteria: [`${id} 验证通过`] });
export function newTracker(data: string): IssueTracker { return new IssueTracker(data, new Map([['plan-mode', PLAN_MODE_PIPELINE]])); }
export function graphFixture(
  tasks = [task('a'), task('b'), task('c', ['a', 'b'])],
  pipeline: PipelineDef = PLAN_MODE_PIPELINE,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '中文 DAG 仓库 '));
  const repo = path.join(directory, 'repo');
  const worktrees = path.join(directory, 'worktrees');
  const data = path.join(directory, 'runtime');
  fs.mkdirSync(repo); fs.mkdirSync(worktrees);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'DAG 测试'); git(repo, 'config', 'user.email', 'dag@example.test'); git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '起点\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', '起点');
  const integration = path.join(worktrees, 'issue-1');
  git(repo, 'worktree', 'add', '-b', 'iaf-1', integration, 'main');
  const tracker = new IssueTracker(data, new Map([[pipeline.mode, pipeline]]));
  tracker.create({ state: IssueState.PhaseRunning, currentPhase: 'build', branchName: 'iaf-1', demandSpec: { demandId: 'gh-1', sourceRef: { source: 'github-issue', externalId: '1', displayId: '1' }, title: '需求', description: '实现任务图', createdAt: new Date().toISOString() } });
  tracker.store.savePlan(1, { title: '需求', description: '实施', acceptanceCriteria: ['全部通过'], tasks }, tracker.get(1)!.run!.version);
  tracker.transaction(1, record => { record.run!.dispatchId = 'first'; record.run!.review!.decision = 'approved'; });
  return { directory, repo, data, worktrees, integration, tracker };
}
export function graphDeps(fixture: ReturnType<typeof graphFixture>, runner: AIRunner, extra: Partial<GraphDependencies> = {}): GraphDependencies {
  return { number: 1, tracker: fixture.tracker, runner, integration: new GitOperations(fixture.integration), repository: new GitOperations(fixture.repo), repositoryMutex: new AsyncMutex(), worktreeRoot: fixture.worktrees, signal: new AbortController().signal, timeoutMs: 10000, install: async () => {}, ...extra };
}
