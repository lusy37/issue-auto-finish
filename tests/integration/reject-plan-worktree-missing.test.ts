/**
 * 集成测试：worktree 缺失时反馈不再静默丢失
 *
 * 修复目标：当 reject-plan 时 worktree 因任何原因不存在（服务重启清理过、
 * 手动删除等），反馈必须能持久化到全局后备路径；下一轮 SetupStep 重建
 * worktree 时再合并回 worktree 内的 review-history.json。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../../src/web/routes/api.js';
import { createMockIssueTracker, createTestConfig } from '../helpers/mock-factories.js';
import { createMockApplyGateAction } from '../helpers/mock-gate-action.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineDefinition.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { IssueState } from '../../src/tracker/IssueState.js';
import type { IssueRecord } from '../../src/tracker/IssueState.js';
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

describe('集成测试：worktree 缺失时 reject-plan 反馈不丢失', () => {
  let tmpDir: string;
  let dataDir: string;
  let server: http.Server;
  let baseUrl: string;
  let cfg: Config;
  let workDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-missing-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    cfg = createTestConfig({
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

    workDir = path.join(cfg.project.worktreeBaseDir, 'issue-42', cfg.project.projectSubDir);
    expect(fs.existsSync(workDir)).toBe(false);

    const tracker = createMockIssueTracker();
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
      // PR4 正统路径：API reject-plan 走 orch.applyGateAction，本测试关注 worktree 缺失
      // 时反馈是否仍持久化到全局后备路径，helper 复现 PipelineOrchestrator.applyGateAction
      // 的全部 reject 副作用（PlanPersistence + tracker + eventBus）
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

  it('worktree 不存在时 POST reject-plan 仍返回 200', async () => {
    const res = await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: '需要更多测试' });
    expect(res.status).toBe(200);
  });

  it('worktree 不存在时反馈持久化到全局后备路径', async () => {
    const feedback = '需要补充 E2E 测试，并改进错误提示文案。';
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback });

    const backupHistory = PlanPersistence.readReviewHistoryBackup(42);
    expect(backupHistory).toHaveLength(1);
    expect(backupHistory[0].round).toBe(1);
    expect(backupHistory[0].feedback).toBe(feedback);
  });

  it('worktree 不存在时多轮驳回累积到全局后备', async () => {
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: '第一次反馈' });
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: '第二次反馈' });

    const backupHistory = PlanPersistence.readReviewHistoryBackup(42);
    expect(backupHistory).toHaveLength(2);
    expect(backupHistory[0].feedback).toBe('第一次反馈');
    expect(backupHistory[1].feedback).toBe('第二次反馈');
  });

  it('worktree 重建后 mergeBackupIfPresent 把后备并入 worktree 并清理后备', async () => {
    const feedback = '这是关键反馈，不能丢失。';
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback });

    fs.mkdirSync(workDir, { recursive: true });
    const plan = new PlanPersistence(workDir, 42);
    plan.ensureDir();

    plan.mergeBackupIfPresent();

    const merged = plan.readReviewHistory();
    expect(merged).toHaveLength(1);
    expect(merged[0].feedback).toBe(feedback);

    expect(PlanPersistence.readReviewHistoryBackup(42)).toEqual([]);
  });

  it('worktree 已有反馈 + 后备反馈时合并保持时间顺序', async () => {
    fs.mkdirSync(workDir, { recursive: true });
    const plan = new PlanPersistence(workDir, 42);
    plan.ensureDir();
    plan.writeReviewFeedback('worktree 已有的旧反馈');

    fs.rmSync(workDir, { recursive: true, force: true });
    await postJson(baseUrl, '/api/issues/42/reject-plan', { feedback: '后备追加的新反馈' });

    fs.mkdirSync(workDir, { recursive: true });
    const plan2 = new PlanPersistence(workDir, 42);
    plan2.ensureDir();
    plan2.writeReviewFeedback('worktree 已有的旧反馈');
    plan2.mergeBackupIfPresent();

    const merged = plan2.readReviewHistory();
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.feedback)).toContain('worktree 已有的旧反馈');
    expect(merged.map((r) => r.feedback)).toContain('后备追加的新反馈');
    expect(merged[0].round).toBe(1);
    expect(merged[1].round).toBe(2);
  });
});
