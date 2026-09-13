import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApiRouter } from '../../src/web/routes/api.js';
import { PipelineOrchestrator } from '../../src/orchestrator/PipelineOrchestrator.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { newTracker } from './dag-repository.js';
import { createTestConfig, createMockGitOperations, createMockGitHubClient, createMockAIRunner } from './mock-factories.js';
import { structuredPlanOutput } from './structured-plan.js';

/** 真实聚合状态、审核事务与 HTTP；仅平台和执行器替换为模拟实现。 */
export async function reviewApi(subdir = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '审核 API '));
  const data = path.join(directory, 'runtime');
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = data;
  const tracker = newTracker(data);
  const config = createTestConfig();
  Object.assign(config.project, { workDir: directory, gitRootDir: directory, worktreeBaseDir: path.join(directory, 'worktrees'), projectSubDir: subdir });
  const github = createMockGitHubClient();
  const orchestrator = new PipelineOrchestrator(config, github as never, createMockGitOperations() as never, createMockAIRunner(), tracker);
  tracker.create({ state: IssueState.PhaseWaiting, currentPhase: 'review', branchName: 'iaf-42', pipelineMode: 'plan-mode',
    demandSpec: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' }, title: '实现页面', description: '父需求快照', createdAt: new Date().toISOString() } });
  const newPlan = (description = '补充页面、错误处理和边界测试') => {
    const plan = tracker.store.savePlan(42, JSON.parse(structuredPlanOutput(description)), tracker.get(42)!.run!.version);
    tracker.updateState(42, IssueState.PhaseWaiting, { currentPhase: 'review' });
    return plan;
  };
  newPlan();
  const persistence = new PlanPersistence(directory, 42, data, tracker);
  const app = express(); app.use(express.json());
  app.use(createApiRouter({ tracker, config, github, orchestrator, agentLogStore: { getLogs: () => [] } as never, supplementStore: undefined as never }));
  let server: Server;
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  const request = async (method: string, endpoint: string, body?: unknown) => {
    const response = await fetch(baseUrl + endpoint, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let payload: any = text;
    try { payload = JSON.parse(text); } catch { /* Markdown 响应保留正文。 */ }
    return { status: response.status, body: payload };
  };
  const decide = (action = 'reject-plan', extra: object = {}) => request('POST', '/api/issues/42/' + action, { planRevision: tracker.get(42)!.run!.planRevision, feedback: '补充错误处理', ...extra });
  return { directory, data, tracker, config, github, orchestrator, persistence, newPlan, request, decide,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); await orchestrator.getDevServerManager().stopAllAndWait(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); } };
}
