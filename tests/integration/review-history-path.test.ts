/** 验证单仓 worktree 在项目根目录和子目录下均能读取审核历史。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../../src/web/routes/api.js';
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

describe('集成测试：单仓 worktree 路径下 review-history 正确读取', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  let cfg: Config;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-history-path-'));
    cfg = buildTestConfig(tmpDir);

    // 隔离 DATA_DIR，避免读取真实运行目录的审核备份
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

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

  it('当 worktree 实际位于 issue-{number}/{subdir} 时，能读出审核历史', async () => {
    // 模拟 WorkspaceManager 的实际目录结构（含配置的项目子目录）
    const planDir = path.join(
      cfg.project.worktreeBaseDir,
      'issue-42',
      cfg.project.projectSubDir,
      '.claude-plan',
      'issue-42',
    );
    fs.mkdirSync(planDir, { recursive: true });

    const history = [
      { round: 1, feedback: '第 1 轮反馈：需要补错误处理', timestamp: '2024-01-01T00:00:00Z' },
      { round: 2, feedback: '第 2 轮反馈：还要补单测', timestamp: '2024-01-02T00:00:00Z' },
    ];
    fs.writeFileSync(
      path.join(planDir, 'review-history.json'),
      JSON.stringify(history, null, 2),
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/review-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const arr = res.body as Array<{ round: number; feedback: string }>;
    expect(arr).toHaveLength(2);
    expect(arr[0].feedback).toContain('第 1 轮反馈');
    expect(arr[1].feedback).toContain('第 2 轮反馈');
  });

  it('项目直接位于仓库根目录时，能读出审核历史', async () => {
    cfg.project.projectSubDir = '';
    const planDir = path.join(
      cfg.project.worktreeBaseDir,
      'issue-42',
      cfg.project.projectSubDir,
      '.claude-plan',
      'issue-42',
    );
    fs.mkdirSync(planDir, { recursive: true });

    const history = [
      { round: 1, feedback: '项目根目录反馈', timestamp: '2024-01-01T00:00:00Z' },
    ];
    fs.writeFileSync(
      path.join(planDir, 'review-history.json'),
      JSON.stringify(history, null, 2),
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/review-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const arr = res.body as Array<{ round: number; feedback: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].feedback).toBe('项目根目录反馈');
  });
});
