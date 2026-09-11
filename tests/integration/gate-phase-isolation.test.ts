import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createApiRouter } from '../../src/web/routes/api.js';
import { IssueState, type IssueRecord } from '../../src/tracker/IssueState.js';
import { PLAN_MODE_PIPELINE, buildPlanModePipeline, _resetPipelineRegistry, registerPipeline } from '../../src/pipeline/PipelineDefinition.js';
import {
  createMockIssueTracker,
  createMockGitHubClient,
  createTestConfig,
} from '../helpers/mock-factories.js';

/**
 * 回归测试：Bug 3 — gate phase 隔离
 *
 * 历史 bug：approve-plan / reject-plan / skip-review
 * 这五个入口都把 currentPhase 硬编码为 'review'。当 issue 处于其它 gate（release/uat）的
 * PhaseWaiting 时，调用这些入口会把 currentPhase 错误地覆盖为 'review'，
 * 下次 drive 时 determineResumePhaseIndex 误认为流水线该从 review 之后开始，
 * 进而触发 build 重跑或最终无法产出 PR。
 *
 * 修复后这些入口必须严格校验 record.currentPhase === gatePhase.name，
 * 否则返回 400 错误（不修改任何状态）。
 */

function createTestRecord(overrides?: Partial<IssueRecord>): IssueRecord {
  return {
    demandSpec: {
      demandId: 'gh-179',
      sourceRef: { source: 'github-issue', externalId: '644949', displayId: '179' },
      title: 'Test Issue',
      description: '',
      createdAt: '2024-01-01T00:00:00Z',
    },
    state: IssueState.PhaseWaiting,
    branchName: 'feat/issue-179',
    attempts: 0,
    pipelineMode: 'plan-mode',
    currentPhase: 'review',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Gate Phase Isolation (Bug 3 regression)', () => {
  let app: express.Application;
  let server: http.Server;
  let baseUrl: string;
  let tracker: ReturnType<typeof createMockIssueTracker>;
  let mockOrchestrator: Record<string, ReturnType<typeof vi.fn>>;

  beforeAll(async () => {
    // 重置流水线注册表，注入启用 release 后的动态流水线
    _resetPipelineRegistry();
    const dynamicDef = buildPlanModePipeline({ releaseEnabled: true, e2eEnabled: true });
    registerPipeline(dynamicDef);

    tracker = createMockIssueTracker();
    const config = createTestConfig();
    const mockAgentLogStore = { getLogs: vi.fn().mockReturnValue([]), startListening: vi.fn() };
    const mockPortAllocator = {
      getPortsForIssue: vi.fn().mockReturnValue(undefined),
      getAllAllocated: vi.fn().mockReturnValue(new Map()),
    };
    const mockDevServerManager = {
      getStatus: vi.fn().mockReturnValue({ running: false }),
      getRunningIssues: vi.fn().mockReturnValue([]),
      stopServers: vi.fn(),
    };
    mockOrchestrator = {
      restartIssue: vi.fn(),
      cancelIssue: vi.fn(),
      retryFromPhase: vi.fn(),
      processIssue: vi.fn(),
      getPipelineDef: vi.fn().mockReturnValue(dynamicDef),
      getPortAllocator: vi.fn().mockReturnValue(mockPortAllocator),
      getDevServerManager: vi.fn().mockReturnValue(mockDevServerManager),
      buildPreviewUrl: vi.fn().mockReturnValue(null),
      getPreviewHost: vi.fn().mockReturnValue('localhost'),
      stopPreviewServers: vi.fn(),
      applyGateAction: vi.fn().mockResolvedValue(undefined),
    };

    app = express();
    app.use(express.json());
    app.use(createApiRouter({tracker: tracker as never,config: config,agentLogStore: mockAgentLogStore as never,orchestrator: mockOrchestrator as never} as never));

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

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetPipelineRegistry();
  });

  beforeEach(() => {
    tracker.get.mockReset();
    tracker.updateState.mockReset();
    tracker.initPhaseProgress.mockReset();
    mockOrchestrator.applyGateAction.mockReset();
    mockOrchestrator.applyGateAction.mockResolvedValue(undefined);
  });

  function postJson(urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const bodyStr = body === undefined ? undefined : JSON.stringify(body);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: bodyStr
          ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) }
          : {},
      };
      const r = http.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      r.on('error', reject);
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  // ─── API: approve-plan ────────────────────────────────────────────────

  describe('POST /api/issues/:number/approve-plan', () => {
    it('approves when currentPhase is the review gate (happy path)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'review' }));
      const res = await postJson('/api/issues/179/approve-plan');
      expect(res.status).toBe(200);
      // PR4 正统路径：API 委托给 orch.applyGateAction，由 Reducer + TrackerStateStore
      // 同步维护 orchestrationState/phaseProgress/phaseHistory（替代旧的直接 tracker.updateState）
      expect(mockOrchestrator.applyGateAction).toHaveBeenCalledWith(179, { action: 'approve' });
    });

    it('REJECTS when currentPhase is release gate (Bug 3 regression)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'release' }));
      const res = await postJson('/api/issues/179/approve-plan');
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/review.*gate.*release/);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });

    it('REJECTS when currentPhase is uat gate (Bug 3 regression)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'uat' }));
      const res = await postJson('/api/issues/179/approve-plan');
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/review.*gate.*uat/);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });

    it('REJECTS when currentPhase is undefined (defensive)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: undefined }));
      const res = await postJson('/api/issues/179/approve-plan');
      expect(res.status).toBe(400);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });
  });

  // ─── API: reject-plan ─────────────────────────────────────────────────

  describe('POST /api/issues/:number/reject-plan', () => {
    it('rejects when currentPhase is review (happy path)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'review' }));
      const res = await postJson('/api/issues/179/reject-plan', { feedback: 'redo plz' });
      expect(res.status).toBe(200);
      // PR4 正统路径：API reject-plan 委托给 orch.applyGateAction（reject）
      expect(mockOrchestrator.applyGateAction).toHaveBeenCalledWith(
        179, { action: 'reject', feedback: 'redo plz' },
      );
    });

    it('REJECTS when currentPhase is release (Bug 3 regression)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'release' }));
      const res = await postJson('/api/issues/179/reject-plan', { feedback: 'feedback' });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/review.*gate.*release/);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });

    it('REJECTS when currentPhase is uat (Bug 3 regression)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'uat' }));
      const res = await postJson('/api/issues/179/reject-plan', { feedback: 'feedback' });
      expect(res.status).toBe(400);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });
  });

  // ─── API: skip-review ─────────────────────────────────────────────────

  describe('POST /api/issues/:number/skip-review', () => {
    it('skips when currentPhase is review (happy path)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'review' }));
      const res = await postJson('/api/issues/179/skip-review');
      expect(res.status).toBe(200);
      expect(mockOrchestrator.applyGateAction).toHaveBeenCalledWith(179, { action: 'approve' });
    });

    it('REJECTS when currentPhase is release (Bug 3 regression)', async () => {
      tracker.get.mockReturnValue(createTestRecord({ currentPhase: 'release' }));
      const res = await postJson('/api/issues/179/skip-review');
      expect(res.status).toBe(400);
      expect(mockOrchestrator.applyGateAction).not.toHaveBeenCalled();
    });
  });
});
