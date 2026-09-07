/**
 * 集成测试：reject-plan → 下一轮 PlanPhase 重新规划时使用历史反馈
 *
 * 目的：防止"反馈静默丢失"回归。覆盖以下链路：
 *   1. POST /api/issues/:number/reject-plan
 *   2. PlanPersistence 写入 review-history.json + review-feedback.md
 *   3. 下一轮 PlanPhase.buildPrompt() 读取 history，使用 rePlanPrompt 并拼接反馈文本
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../../src/web/routes/api.js';
import {
  createMockIssueTracker,
  createMockGitOperations,
  createMockAIRunner,
  createTestConfig,
} from '../helpers/mock-factories.js';
import { createMockApplyGateAction } from '../helpers/mock-gate-action.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineDefinition.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import type { IssueRecord } from '../../src/tracker/IssueState.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { Config } from '../../src/config.js';

interface ApiResponse {
  status: number;
  body: unknown;
}

function postJson(baseUrl: string, urlPath: string, jsonBody: unknown): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const bodyStr = JSON.stringify(jsonBody);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body: unknown;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function buildTestConfig(tmpDir: string): Config {
  return createTestConfig({
    project: {
      workDir: path.join(tmpDir, 'workdir'),
      gitRootDir: path.join(tmpDir, 'gitroot'),
      baseBranch: 'master',
      branchPrefix: 'feat/issue',
      worktreeBaseDir: path.join(tmpDir, 'worktrees'),
      projectSubDir: 'app/test-project',
    },
    issueNoteSync: { enabled: false, webBaseUrl: 'http://localhost:3000' },
  });
}

function createWaitingIssueRecord(number: number): IssueRecord {
  return {
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue', externalId: String(number * 10), displayId: String(number) },
      title: 'Test Issue',
      description: 'Some description',
      createdAt: '2024-01-01T00:00:00Z',
    },
    state: IssueState.PhaseWaiting,
    currentPhase: 'review',
    branchName: `feat/issue-${number}`,
    attempts: 0,
    pipelineMode: 'plan-mode',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  } as IssueRecord;
}

describe('集成测试：reject-plan → 下一轮 PlanPhase 使用反馈重新规划', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  let cfg: Config;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let workDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-flow-'));
    cfg = buildTestConfig(tmpDir);
    // 隔离 DATA_DIR，避免污染真实 ~/.issue-auto-finish/data/review-backups/
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    // 模拟 WorkspaceManager 多 repo 模式的实际路径：含 primary/ 子目录
    workDir = path.join(cfg.project.worktreeBaseDir, 'issue-42', cfg.project.projectSubDir);

    fs.mkdirSync(workDir, { recursive: true });
    const planDir = path.join(workDir, '.claude-plan', 'issue-42');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, '01-plan.md'),
      '# 初版方案\n\n这是一份初步实施计划。需要进一步完善。\n',
    );

    tracker = createMockIssueTracker();
    tracker.get.mockReturnValue(createWaitingIssueRecord(42));

    const mockAgentLogStore = { getLogs: vi.fn().mockReturnValue([]), startListening: vi.fn() };
    const mockOrchestrator = {
      restartIssue: vi.fn().mockResolvedValue(undefined),
      cancelIssue: vi.fn().mockResolvedValue(undefined),
      retryFromPhase: vi.fn(),
      processIssue: vi.fn().mockResolvedValue(undefined),
      getPipelineDef: vi.fn().mockReturnValue(PLAN_MODE_PIPELINE),
      getPortAllocator: vi.fn().mockReturnValue({
        getPortsForIssue: vi.fn().mockReturnValue(undefined),
        getAllAllocated: vi.fn().mockReturnValue(new Map()),
      }),
      getDevServerManager: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockReturnValue({ running: false }),
        getRunningIssues: vi.fn().mockReturnValue([]),
        stopServers: vi.fn(),
      }),
      buildPreviewUrl: vi.fn().mockReturnValue(null),
      getPreviewHost: vi.fn().mockReturnValue('localhost'),
      stopPreviewServers: vi.fn(),
      // PR4 正统路径：API reject-plan 调 orch.applyGateAction，由 PipelineOrchestrator
      // 内部完成 PlanPersistence 持久化 + 状态转移。测试用 helper 重现等价副作用。
      applyGateAction: vi.fn(createMockApplyGateAction({
        tracker, config: cfg, pipelineDef: PLAN_MODE_PIPELINE,
      })),
    };

    const app = express();
    app.use(express.json());
    app.use(createApiRouter({tracker: tracker as never,config: cfg,agentLogStore: mockAgentLogStore as never,orchestrator: mockOrchestrator as never} as never));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('驳回后 worktree 内 review-history.json 包含本轮反馈（primary 子目录路径）', async () => {
    const feedback = '请补充错误处理逻辑，并增加单元测试覆盖。';

    const res = await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback });
    expect(res.status).toBe(200);

    // 反馈必须写到 primary/{subdir}/.claude-plan/issue-{number}/review-history.json
    // 而不是 backup 目录（worktree 已存在时的优先路径）
    const historyFile = path.join(workDir, '.claude-plan', 'issue-42', 'review-history.json');
    expect(fs.existsSync(historyFile)).toBe(true);

    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(history).toHaveLength(1);
    expect(history[0].round).toBe(1);
    expect(history[0].feedback).toBe(feedback);
  });

  it('驳回后 review-feedback.md 渲染历史反馈', async () => {
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: '需要支持中文' });

    const mdFile = path.join(workDir, '.claude-plan', 'issue-42', 'review-feedback.md');
    expect(fs.existsSync(mdFile)).toBe(true);

    const md = fs.readFileSync(mdFile, 'utf-8');
    expect(md).toContain('审核反馈历史');
    expect(md).toContain('第 1 轮');
    expect(md).toContain('需要支持中文');
  });

  it('下一轮 PlanPhase.buildPrompt 走 rePlanPrompt 并拼接反馈文本', async () => {
    const feedback = '关键缺失：未考虑权限校验。';
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback });

    const plan = new PlanPersistence(workDir, 42);
    const phase = new PlanPhase(
      createMockAIRunner() as never,
      createMockGitOperations() as never,
      plan,
      cfg,
    );

    const ctx: PhaseContext = {
      demand: {
        demandId: 'gh-42',
        sourceRef: { source: 'github-issue', externalId: '420', displayId: '42' },
        title: 'Test Issue',
        description: '需求描述',
        createdAt: '2024-01-01T00:00:00Z',
      },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const prompt = (phase as unknown as { buildPrompt: (c: PhaseContext) => string }).buildPrompt(ctx);

    expect(prompt).toContain('审核反馈');
    expect(prompt).toContain(feedback);
    expect(prompt).not.toContain('一次性完成需求分析和方案设计');
  });

  it('多轮驳回 累积所有历史反馈到 prompt', async () => {
    const fb1 = '第一轮：缺少错误处理';
    const fb2 = '第二轮：测试覆盖不足';

    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: fb1 });
    tracker.get.mockReturnValue(createWaitingIssueRecord(42));
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: fb2 });

    const plan = new PlanPersistence(workDir, 42);
    const phase = new PlanPhase(
      createMockAIRunner() as never,
      createMockGitOperations() as never,
      plan,
      cfg,
    );

    const ctx: PhaseContext = {
      demand: {
        demandId: 'gh-42',
        sourceRef: { source: 'github-issue', externalId: '420', displayId: '42' },
        title: 'Test Issue',
        description: '需求描述',
        createdAt: '2024-01-01T00:00:00Z',
      },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const prompt = (phase as unknown as { buildPrompt: (c: PhaseContext) => string }).buildPrompt(ctx);

    expect(prompt).toContain(fb1);
    expect(prompt).toContain(fb2);
    expect(prompt).toContain('第 1 轮');
    expect(prompt).toContain('第 2 轮');
  });

  it('驳回时 review-history.json 包含当前 plan 的 planSnapshot 字段', async () => {
    const res = await postJson(baseUrl, '/api/issues/42/reject-plan', {
      feedback: '请补充错误处理',
    });
    expect(res.status).toBe(200);

    const historyFile = path.join(workDir, '.claude-plan', 'issue-42', 'review-history.json');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(history).toHaveLength(1);
    expect(history[0].planSnapshot).toBe(
      '# 初版方案\n\n这是一份初步实施计划。需要进一步完善。\n',
    );
  });

  it('多轮驳回时各轮 planSnapshot 反映当时的 01-plan.md 内容', async () => {
    // round 1: 现有 01-plan.md 是 beforeEach 写入的"初版方案"
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: 'round-1 feedback' });

    // 模拟 AI 重新规划后改写了 01-plan.md
    fs.writeFileSync(
      path.join(workDir, '.claude-plan', 'issue-42', '01-plan.md'),
      '# 改进版方案\n\n已补充错误处理逻辑。\n',
      'utf-8',
    );

    tracker.get.mockReturnValue(createWaitingIssueRecord(42));
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: 'round-2 feedback' });

    const historyFile = path.join(workDir, '.claude-plan', 'issue-42', 'review-history.json');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(history).toHaveLength(2);
    expect(history[0].planSnapshot).toContain('初版方案');
    expect(history[1].planSnapshot).toContain('改进版方案');
    expect(history[1].planSnapshot).toContain('已补充错误处理逻辑');
  });

  it('01-plan.md 不存在时 planSnapshot 为 undefined（不抛异常，反馈仍记录）', async () => {
    // 删除现有 01-plan.md
    fs.rmSync(path.join(workDir, '.claude-plan', 'issue-42', '01-plan.md'));

    const res = await postJson(baseUrl, '/api/issues/42/reject-plan', {
      feedback: '无 plan 也能驳回',
    });
    expect(res.status).toBe(200);

    const historyFile = path.join(workDir, '.claude-plan', 'issue-42', 'review-history.json');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(history).toHaveLength(1);
    expect(history[0].feedback).toBe('无 plan 也能驳回');
    expect(history[0].planSnapshot).toBeUndefined();
  });
});
