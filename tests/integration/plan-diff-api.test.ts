/**
 * 集成测试：GET /api/issues/:number/plan-diff
 *
 * 新机制：以 review-history.json 中最近一轮的 planSnapshot 为基线，
 * 对比 worktree 中 01-plan.md 的当前版本。
 * 替代了旧的"worktree vs git HEAD" 实现 —— 因为 worktree 与主仓库共享 .git，
 * 一旦本轮 plan commit 完成 HEAD 立刻同步到本轮版本，diff 会反而归零；
 * 而 AI 正在写入的中间态又会显示半成品脏内容。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../../src/web/routes/api.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import {
  createMockIssueTracker,
  createTestConfig,
} from '../helpers/mock-factories.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineDefinition.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import type { IssueRecord } from '../../src/tracker/IssueState.js';
import type { Config } from '../../src/config.js';

interface ApiResponse {
  status: number;
  body: unknown;
}

function getJson(baseUrl: string, urlPath: string): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + (url.search ?? ''),
        method: 'GET',
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

function createReviewWaitingRecord(number: number): IssueRecord {
  return {
    demandSpec: {
      demandId: `gh-${number}`,
      sourceRef: { source: 'github-issue', externalId: String(number * 10), displayId: String(number) },
      title: 'Test Issue',
      description: '',
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

describe('集成测试：plan-diff API 基于 review-history snapshot 展示本轮 vs 上轮改进', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  let cfg: Config;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let workDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-diff-'));
    cfg = buildTestConfig(tmpDir);

    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

    // 模拟 multi-repo workspace 实际路径：含 primary/ 子目录
    workDir = path.join(
      cfg.project.worktreeBaseDir,
      'issue-42',
      cfg.project.projectSubDir,
    );
    fs.mkdirSync(workDir, { recursive: true });

    tracker = createMockIssueTracker();
    tracker.get.mockReturnValue(createReviewWaitingRecord(42));

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

  it('当前 plan 与最近一轮 planSnapshot 不同时返回 unified diff（含 + 与 - 行）', async () => {
    const plan = new PlanPersistence(workDir, 42);
    // 模拟上一轮被驳回时的 plan 内容写入 history 的 snapshot
    plan.writeReviewFeedback(
      '请补充错误处理',
      '# 计划\n\n第 1 步：分析\n第 2 步：实施\n第 3 步：验证\n',
    );
    // worktree 中的新版（含错误处理改进）
    fs.writeFileSync(
      path.join(workDir, '.claude-plan', 'issue-42', '01-plan.md'),
      '# 计划\n\n第 1 步：分析\n第 2 步：实施（新增：错误处理）\n第 3 步：验证\n',
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(true);
    expect(body.diff).toContain('@@');
    expect(body.diff).toContain('-第 2 步：实施');
    expect(body.diff).toContain('+第 2 步：实施（新增：错误处理）');
    // diff header 应当用 round-N 而不是 HEAD
    expect(body.diff).toContain('round-1');
  });

  it('两版本相同时返回空 diff 且 hasChanges=false', async () => {
    const plan = new PlanPersistence(workDir, 42);
    const sameContent = '# 完全相同的计划\n第 1 步\n';
    plan.writeReviewFeedback('需要改进', sameContent);
    fs.writeFileSync(
      path.join(workDir, '.claude-plan', 'issue-42', '01-plan.md'),
      sameContent,
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(false);
  });

  it('无 review-history（首轮）返回 hasChanges=false', async () => {
    const planDir = path.join(workDir, '.claude-plan', 'issue-42');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-plan.md'), '# 首版\n', 'utf-8');

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(false);
    expect(body.diff).toBe('');
  });

  it('review-history 存在但缺少 planSnapshot（旧数据）返回 hasChanges=false', async () => {
    const planDir = path.join(workDir, '.claude-plan', 'issue-42');
    fs.mkdirSync(planDir, { recursive: true });
    // 旧数据：history 项没有 planSnapshot 字段
    fs.writeFileSync(
      path.join(planDir, 'review-history.json'),
      JSON.stringify([
        { round: 1, feedback: '旧反馈', timestamp: '2024-01-01T00:00:00Z' },
      ]),
      'utf-8',
    );
    fs.writeFileSync(path.join(planDir, '01-plan.md'), '# 新内容\n', 'utf-8');

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(false);
  });

  it('多轮驳回时基线取最近一轮（round-N），不取第一轮', async () => {
    const plan = new PlanPersistence(workDir, 42);
    plan.writeReviewFeedback('第一轮反馈', '# v1 \n第一版内容\n');
    plan.writeReviewFeedback('第二轮反馈', '# v2 \n第二版内容\n');
    fs.writeFileSync(
      path.join(workDir, '.claude-plan', 'issue-42', '01-plan.md'),
      '# v3 \n第三版内容\n',
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(true);
    expect(body.diff).toContain('round-2');
    expect(body.diff).toContain('-第二版内容');
    expect(body.diff).toContain('+第三版内容');
    expect(body.diff).not.toContain('第一版内容');
  });

  it('worktree 不存在时返回 hasChanges=false（不抛异常）', async () => {
    // 删除 worktree 目录
    fs.rmSync(workDir, { recursive: true, force: true });

    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=01-plan.md');
    expect(res.status).toBe(200);
    const body = res.body as { diff: string; hasChanges: boolean };
    expect(body.hasChanges).toBe(false);
  });

  it('Issue 不存在返回 404', async () => {
    tracker.get.mockReturnValue(null);
    const res = await getJson(baseUrl, '/api/issues/99/plan-diff?file=01-plan.md');
    expect(res.status).toBe(404);
  });

  it('非法文件名返回 400', async () => {
    const res = await getJson(baseUrl, '/api/issues/42/plan-diff?file=../etc/passwd');
    expect(res.status).toBe(400);
  });
});
