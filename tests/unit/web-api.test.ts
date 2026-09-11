import { GitHubClient } from '../../src/clients/GitHubClient.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createApiRouter } from '../../src/web/routes/api.js';
import { createMockIssueTracker, createMockGitOperations, createTestConfig } from '../helpers/mock-factories.js';
import { PLAN_MODE_PIPELINE } from '../../src/pipeline/PipelineDefinition.js';
import type { IssueRecord } from '../../src/tracker/IssueState.js';

function createTestRecord(overrides?: Partial<IssueRecord>): IssueRecord {
  return {
    demandSpec: {
      demandId: 'gh-42',
      sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
      title: 'Test Issue',
      description: '',
      createdAt: '2024-01-01T00:00:00Z',
    },
    state: 'pending' as IssueRecord['state'],
    branchName: 'feat/issue-42',
    attempts: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const tracker = createMockIssueTracker();
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
const mockOrchestrator = {
  restartIssue: vi.fn().mockResolvedValue(undefined),
  cancelIssue: vi.fn().mockResolvedValue(undefined),
  retryFromPhase: vi.fn(),
  processIssue: vi.fn().mockResolvedValue(undefined),
  getPipelineDef: vi.fn().mockReturnValue(PLAN_MODE_PIPELINE),
  getPortAllocator: vi.fn().mockReturnValue(mockPortAllocator),
  getDevServerManager: vi.fn().mockReturnValue(mockDevServerManager),
  buildPreviewUrl: vi.fn().mockReturnValue(null),
  getPreviewHost: vi.fn().mockReturnValue('localhost'),
  stopPreviewServers: vi.fn(),
  getWorktreeStatus: vi.fn().mockReturnValue({ exists: true }),
};
const app = express();
app.use(express.json());
app.use(createApiRouter({tracker: tracker as never,config: config,github: new GitHubClient(config.github),agentLogStore: mockAgentLogStore as never,orchestrator: mockOrchestrator as never} as never));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
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
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function req(method: string, urlPath: string, jsonBody?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const headers: Record<string, string> = {};
    let bodyStr: string | undefined;
    if (jsonBody !== undefined) {
      bodyStr = JSON.stringify(jsonBody);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    };
    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body: unknown;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

describe('API Routes', () => {
  describe('GET /api/issues', () => {
    it('returns empty array when no issues', async () => {
      tracker.getAll.mockReturnValue([]);
      const res = await req('GET', '/api/issues');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all tracked issues', async () => {
      const records = [createTestRecord(), createTestRecord({
        demandSpec: {
          demandId: 'gh-43',
          sourceRef: { source: 'github-issue', externalId: '100', displayId: '43' },
          title: 'Another',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
      })];
      tracker.getAll.mockReturnValue(records);
      const res = await req('GET', '/api/issues');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as IssueRecord[]).length).toBe(2);
    });
  });

  describe('GET /api/issues/:number', () => {
    it('returns 404 when issue not found', async () => {
      tracker.get.mockReturnValue(undefined);
      const res = await req('GET', '/api/issues/999');
      expect(res.status).toBe(404);
    });

    it('returns issue detail', async () => {
      const record = createTestRecord();
      tracker.get.mockReturnValue(record);
      const res = await req('GET', '/api/issues/42');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown> & { demandSpec: { sourceRef: { displayId: string } } }).demandSpec.sourceRef.displayId).toBe('42');
    });
  });

  describe('POST /api/issues/:number/retry', () => {
    it('returns 400 when issue is not failed', async () => {
      tracker.resetForRetry.mockReturnValue(false);
      const res = await req('POST', '/api/issues/42/retry');
      expect(res.status).toBe(400);
    });

    it('returns success when issue is reset', async () => {
      tracker.resetForRetry.mockReturnValue(true);
      const res = await req('POST', '/api/issues/42/retry');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
    });
  });

  describe('POST /api/issues/:number/cancel', () => {
    it('returns 404 when issue not found', async () => {
      tracker.get.mockReturnValue(undefined);
      const res = await req('POST', '/api/issues/42/cancel');
      expect(res.status).toBe(404);
    });

    it('returns success when issue is cancelled', async () => {
      tracker.get.mockReturnValue(createTestRecord());
      mockOrchestrator.cancelIssue.mockResolvedValue(undefined);
      const res = await req('POST', '/api/issues/42/cancel');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
      expect(mockOrchestrator.cancelIssue).toHaveBeenCalledWith(42);
    });

    it('returns 400 when cancelIssue throws', async () => {
      tracker.get.mockReturnValue(createTestRecord());
      mockOrchestrator.cancelIssue.mockRejectedValue(new Error('cancel failed'));
      const res = await req('POST', '/api/issues/42/cancel');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/system/status', () => {
    it('returns system status', async () => {
      tracker.getAll.mockReturnValue([]);
      tracker.getAllActive.mockReturnValue([]);
      const res = await req('GET', '/api/system/status');
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('config');
      expect(body).toHaveProperty('issues');
    });
  });

  describe('GET /api/issues/:number/plans/:filename', () => {
    it('returns 400 for invalid filename', async () => {
      const res = await req('GET', '/api/issues/42/plans/evil.sh');
      expect(res.status).toBe(400);
    });

    it('returns 404 when plan file not found', async () => {
      const res = await req('GET', '/api/issues/42/plans/01-plan.md');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/issues/:number/restart', () => {
    it('returns success when orchestrator restarts issue', async () => {
      mockOrchestrator.restartIssue.mockResolvedValue(undefined);
      const res = await req('POST', '/api/issues/42/restart');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
      expect(mockOrchestrator.restartIssue).toHaveBeenCalledWith(42);
    });

    it('returns 400 when orchestrator throws', async () => {
      mockOrchestrator.restartIssue.mockRejectedValue(new Error('Issue 999 not found in tracker'));
      const res = await req('POST', '/api/issues/999/restart');
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain('not found');
    });
  });

  describe('POST /api/issues/:number/retry-from-phase', () => {
    it('returns success with valid phase', async () => {
      mockOrchestrator.retryFromPhase.mockReturnValue(undefined);
      const res = await req('POST', '/api/issues/42/retry-from-phase', { phase: 'build' });
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).success).toBe(true);
      expect(mockOrchestrator.retryFromPhase).toHaveBeenCalledWith(42, 'build');
    });

    it('returns 400 with invalid phase', async () => {
      const res = await req('POST', '/api/issues/42/retry-from-phase', { phase: 'invalid' });
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain('Invalid phase');
    });

    it('returns 400 with missing phase', async () => {
      const res = await req('POST', '/api/issues/42/retry-from-phase', {});
      expect(res.status).toBe(400);
    });

    it('returns 400 when orchestrator throws', async () => {
      mockOrchestrator.retryFromPhase.mockImplementation(() => { throw new Error('not found'); });
      const res = await req('POST', '/api/issues/42/retry-from-phase', { phase: 'plan' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/issues/:number/plans/:filename', () => {
    it('returns 400 for non-editable filename', async () => {
      const res = await req('PUT', '/api/issues/42/plans/02-verify-report.md', { content: 'test' });
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain('not editable');
    });

    it('returns 400 when content field is missing', async () => {
      const res = await req('PUT', '/api/issues/42/plans/01-plan.md', { foo: 'bar' });
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toContain('content');
    });

    it('returns 404 when plan directory does not exist', async () => {
      const res = await req('PUT', '/api/issues/42/plans/01-plan.md', { content: 'test' });
      expect(res.status).toBe(404);
    });
  });
});

describe('API Routes — git fallback for plan files', () => {
  const fbTracker = createMockIssueTracker();
  const fbConfig = createTestConfig();
  const fbMockGit = createMockGitOperations();
  const fbMockAgentLogStore = { getLogs: vi.fn().mockReturnValue([]), startListening: vi.fn() };
  const fbMockPortAllocator = {
    getPortsForIssue: vi.fn().mockReturnValue(undefined),
    getAllAllocated: vi.fn().mockReturnValue(new Map()),
  };
  const fbMockDevServerManager = {
    getStatus: vi.fn().mockReturnValue({ running: false }),
    getRunningIssues: vi.fn().mockReturnValue([]),
    stopServers: vi.fn(),
  };
  const fbMockOrchestrator = {
    restartIssue: vi.fn().mockResolvedValue(undefined),
    retryFromPhase: vi.fn(),
    processIssue: vi.fn().mockResolvedValue(undefined),
    getPipelineDef: vi.fn().mockReturnValue(PLAN_MODE_PIPELINE),
    getPortAllocator: vi.fn().mockReturnValue(fbMockPortAllocator),
    getDevServerManager: vi.fn().mockReturnValue(fbMockDevServerManager),
    buildPreviewUrl: vi.fn().mockReturnValue(null),
    getPreviewHost: vi.fn().mockReturnValue('localhost'),
    stopPreviewServers: vi.fn(),
    getWorktreeStatus: vi.fn().mockReturnValue({ exists: true }),
  };

  const fbApp = express();
  fbApp.use(express.json());
  fbApp.use(createApiRouter({tracker: fbTracker as never,config: fbConfig,agentLogStore: fbMockAgentLogStore as never,orchestrator: fbMockOrchestrator as never,mainGit: fbMockGit as never} as never));

  let fbServer: http.Server;
  let fbBaseUrl: string;

  beforeAll(async () => {
    await new Promise<void>(resolve => {
      fbServer = fbApp.listen(0, () => {
        const addr = fbServer.address();
        if (addr && typeof addr !== 'string') {
          fbBaseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      fbServer.close(() => resolve());
    });
  });

  beforeEach(() => {
    fbMockGit.showFile.mockReset().mockResolvedValue(null);
    fbTracker.get.mockReset().mockReturnValue(undefined);
  });

  function fbReq(method: string, urlPath: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, fbBaseUrl);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
      };
      const r = http.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body: unknown;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      r.on('error', reject);
      r.end();
    });
  }

  it('falls back to git show when worktree plan file does not exist', async () => {
    const record = createTestRecord({ branchName: 'feat/issue-42' });
    fbTracker.get.mockReturnValue(record);
    fbMockGit.showFile.mockResolvedValue('# Plan Result\nSome plan content');

    const res = await fbReq('GET', '/api/issues/42/plans/01-plan.md');

    expect(res.status).toBe(200);
    expect(res.body).toContain('Plan Result');
    expect(fbMockGit.showFile).toHaveBeenCalledWith(
      'feat/issue-42',
      'app/mmpayxdcdevopslogicsvr/.claude-plan/issue-42/01-plan.md',
    );
  });

  it('returns 404 when both worktree and git have no plan file', async () => {
    fbTracker.get.mockReturnValue(undefined);
    fbMockGit.showFile.mockResolvedValue(null);

    const res = await fbReq('GET', '/api/issues/999/plans/01-plan.md');

    expect(res.status).toBe(404);
  });

  it('reads progress.json from git when worktree is cleaned', async () => {
    const progress = {
      displayId: 100,
      title: 'Test',
      branchName: 'feat/issue-42',
      currentPhase: 'verify',
      phases: {
        plan: { status: 'completed' },
        review: { status: 'completed' },
        build: { status: 'completed' },
        verify: { status: 'completed' },
      },
    };
    const record = createTestRecord({ branchName: 'feat/issue-42' });
    fbTracker.get.mockReturnValue(record);
    fbMockGit.showFile.mockResolvedValue(JSON.stringify(progress));

    const res = await fbReq('GET', '/api/issues/42/plans/progress.json');

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).currentPhase).toBe('verify');
  });

  it('returns progress in issue detail via git fallback', async () => {
    const progress = {
      displayId: 100,
      title: 'Test',
      branchName: 'feat/issue-42',
      currentPhase: 'build',
      phases: {
        plan: { status: 'completed' },
        review: { status: 'completed' },
        build: { status: 'in_progress' },
        verify: { status: 'pending' },
      },
    };
    const record = createTestRecord({ branchName: 'feat/issue-42', state: 'phase_running' as any, attempts: 1 });
    fbTracker.get.mockReturnValue(record);
    fbMockGit.showFile.mockResolvedValue(JSON.stringify(progress));

    const res = await fbReq('GET', '/api/issues/42');

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect((body as any).demandSpec.sourceRef.displayId).toBe('42');
    expect(body.progress).toBeTruthy();
    expect((body.progress as Record<string, unknown>).currentPhase).toBe('build');
  });
});
