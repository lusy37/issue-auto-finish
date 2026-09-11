/**
 * 集成测试：GET /api/issues/:number/review-history 在 worktree 缺失时
 * 能 fallback 到全局 backup 目录（resolveDataDir() 下的 review-backups/）。
 *
 * 同时验证：worktree 与 backup 都有数据时，能合并 + 按时间排序 + 重新编号。
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

describe('集成测试：review-history API 在 worktree 缺失时 fallback 到 backup', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  let cfg: Config;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-backup-'));
    cfg = buildTestConfig(tmpDir);

    // 把 backup 目录指向临时 data 目录，避免污染真实 ~/.issue-auto-finish/data/
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

  it('worktree 不存在时，fallback 读取 backup 中的反馈', async () => {
    const backupDir = path.join(process.env.DATA_DIR!, 'review-backups', 'issue-42');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = [
      { round: 1, feedback: '来自 backup 的反馈', timestamp: '2024-03-01T00:00:00Z' },
    ];
    fs.writeFileSync(
      path.join(backupDir, 'review-history.json'),
      JSON.stringify(backup, null, 2),
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/review-history');
    expect(res.status).toBe(200);
    const arr = res.body as Array<{ round: number; feedback: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].feedback).toBe('来自 backup 的反馈');
  });

  it('worktree 与 backup 都有反馈时，合并 + 按时间排序 + 重新编号', async () => {
    // worktree 反馈（更晚）
    const primaryPlanDir = path.join(
      cfg.project.worktreeBaseDir,
      'issue-42',
      cfg.project.projectSubDir,
      '.claude-plan',
      'issue-42',
    );
    fs.mkdirSync(primaryPlanDir, { recursive: true });
    fs.writeFileSync(
      path.join(primaryPlanDir, 'review-history.json'),
      JSON.stringify([
        { round: 1, feedback: 'worktree-later', timestamp: '2024-03-05T00:00:00Z' },
      ], null, 2),
      'utf-8',
    );

    // backup 反馈（更早，但 round 也是 1 — 来自 worktree 缺失期的写入）
    const backupDir = path.join(process.env.DATA_DIR!, 'review-backups', 'issue-42');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, 'review-history.json'),
      JSON.stringify([
        { round: 1, feedback: 'backup-earlier', timestamp: '2024-03-01T00:00:00Z' },
      ], null, 2),
      'utf-8',
    );

    const res = await getJson(baseUrl, '/api/issues/42/review-history');
    expect(res.status).toBe(200);
    const arr = res.body as Array<{ round: number; feedback: string; timestamp: string }>;
    expect(arr).toHaveLength(2);
    // 按 timestamp 升序 + 重新编号
    expect(arr[0].round).toBe(1);
    expect(arr[0].feedback).toBe('backup-earlier');
    expect(arr[1].round).toBe(2);
    expect(arr[1].feedback).toBe('worktree-later');
  });
});
