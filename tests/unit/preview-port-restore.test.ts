import { newIssueRun } from '../../src/dag/contracts.js';
vi.mock('../../src/orchestrator/DagPhaseRunner.js', () => ({ DagPhaseRunner: isolatedPhaseRunner((...args) => mockPhaseRun(...args)) }));
import { isolatedPhaseRunner } from '../helpers/isolated-phase-runner.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueState } from '../../src/tracker/IssueState.js';
import { buildPlanModePipeline } from '../../src/pipeline/PipelineDefinition.js';
import type { IssueProcessingContext, OrchestratorDeps } from '../../src/orchestrator/IssueProcessingContext.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { PortPair } from '../../src/deploy/PortAllocator.js';
import type { WorktreeContext } from '../../src/git/WorktreeContext.js';
import {
  createMockGitOperations,
  createTestConfig,
  createTestIssue,
  createMockIssueTracker,
  createMockOrchestratorDeps,
} from '../helpers/mock-factories.js';

const mockPhaseRun = vi.fn().mockResolvedValue({ kind: 'completed', output: 'ok' });

vi.mock('../../src/phases/PhaseFactory.js', () => ({
  createPhase: vi.fn().mockImplementation((name: string) => ({
    phaseName: name,
    run: mockPhaseRun,
    getResultFiles: vi.fn().mockReturnValue([]),
    setWtGitMap: vi.fn(),
  })),
}));

const { executePhaseLoop } = await import('../../src/orchestrator/steps/PhaseLoopStep.js');

function createMockWtPlan() {
  return {
    baseDir: '/tmp/test-worktrees/issue-42/app/test',
    ensureDir: vi.fn(),
    writeIssueMeta: vi.fn(),
    writeProgress: vi.fn(),
    readProgress: vi.fn().mockReturnValue(null),
    getAllPlanFiles: vi.fn().mockReturnValue([]),
    createInitialProgress: vi.fn().mockReturnValue({
      displayId: 42,
      title: 'Test',
      branchName: 'feat/issue-42',
      currentPhase: 'uat',
      phases: {},
    }),
    updatePhaseProgress: vi.fn(),
    updatePhaseSessionId: vi.fn(),
  } as any;
}

function createMockWtCtx(issueIid = 42): WorktreeContext {
  return {
    gitRootDir: '/tmp/test-worktrees/issue-42',
    workDir: '/tmp/test-worktrees/issue-42/app/test',
    branchName: 'feat/issue-42',
    issueIid,
  };
}

describe('Preview port restore on retry', () => {
  const MOCK_PORTS: PortPair = { backendPort: 4001, frontendPort: 9001 };
  let config = createTestConfig({ e2e: { enabled: true }, preview: { enabled: true } });
  let mockTracker = createMockIssueTracker();

  beforeEach(() => {
    vi.clearAllMocks();
    config = createTestConfig({
      e2e: { enabled: true },
      preview: { enabled: true },
      verifyFixLoop: { enabled: false, maxIterations: 3, todolistCheckEnabled: false },
    });
    mockTracker = createMockIssueTracker();
  });

  function buildDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
    return createMockOrchestratorDeps({
      config,
      tracker: mockTracker as any,
      shouldDeployServers: vi.fn().mockReturnValue(true),
      startPreviewServers: vi.fn().mockResolvedValue(MOCK_PORTS),
      buildPreviewUrl: vi.fn().mockReturnValue('https://10.0.0.1:9001'),
      ...overrides,
    });
  }

  function bindTrackerToRecord(ctx: IssueProcessingContext): void {
    ctx.record.run ??= newIssueRun();
    mockTracker.get.mockImplementation(() => ctx.record as any);
  }

  it('restores ports from portAllocator when resuming past deploysPreview phase', async () => {
    const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
    const issue = createTestIssue();
    const wtCtx = createMockWtCtx();

    const phaseCtx: PhaseContext = {
      demand: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' }, title: 'Test', description: 'desc' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const deps = buildDeps({
      getPortsForIssue: vi.fn().mockReturnValue(MOCK_PORTS),
      isPreviewRunning: vi.fn().mockReturnValue(true),
    });

    const ctx: IssueProcessingContext = {
      issue, branchName: 'feat/issue-42', wtCtx, phaseCtx,
      record: {
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Failed,
        failedAtState: IssueState.PhaseRunning,
        currentPhase: 'uat',
        pipelineMode: 'plan-mode',
        attempts: 1,
      } as any,
      isRetry: true,
      pipelineDef,
      demand: phaseCtx.demand,
    };

    bindTrackerToRecord(ctx);
    await executePhaseLoop(ctx, deps, createMockGitOperations() as any, createMockWtPlan());

    expect(deps.getPortsForIssue).toHaveBeenCalledWith(42);
    expect(phaseCtx.ports).toEqual(MOCK_PORTS);
    expect(wtCtx.ports).toEqual(MOCK_PORTS);
    expect(deps.startPreviewServers).not.toHaveBeenCalled();
  });

  it('auto-starts preview when resuming past deploysPreview with no existing allocation', async () => {
    const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
    const issue = createTestIssue();
    const wtCtx = createMockWtCtx();

    const phaseCtx: PhaseContext = {
      demand: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' }, title: 'Test', description: 'desc' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const deps = buildDeps({
      getPortsForIssue: vi.fn().mockReturnValue(undefined),
    });

    const ctx: IssueProcessingContext = {
      issue, branchName: 'feat/issue-42', wtCtx, phaseCtx,
      record: {
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Failed,
        failedAtState: IssueState.PhaseRunning,
        currentPhase: 'uat',
        pipelineMode: 'plan-mode',
        attempts: 1,
      } as any,
      isRetry: true,
      pipelineDef,
      demand: phaseCtx.demand,
    };

    bindTrackerToRecord(ctx);
    await executePhaseLoop(ctx, deps, createMockGitOperations() as any, createMockWtPlan());

    expect(deps.getPortsForIssue).toHaveBeenCalledWith(42);
    expect(deps.startPreviewServers).toHaveBeenCalledWith(wtCtx, issue);
    expect(phaseCtx.ports).toEqual(MOCK_PORTS);
  });

  it('restarts preview when ports allocated but servers not running (e.g. after service restart)', async () => {
    const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
    const issue = createTestIssue();
    const wtCtx = createMockWtCtx();

    const phaseCtx: PhaseContext = {
      demand: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' }, title: 'Test', description: 'desc' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const deps = buildDeps({
      getPortsForIssue: vi.fn().mockReturnValue(MOCK_PORTS),
      isPreviewRunning: vi.fn().mockReturnValue(false),
    });

    const ctx: IssueProcessingContext = {
      issue, branchName: 'feat/issue-42', wtCtx, phaseCtx,
      record: {
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Failed,
        failedAtState: IssueState.PhaseRunning,
        currentPhase: 'uat',
        pipelineMode: 'plan-mode',
        attempts: 1,
      } as any,
      isRetry: true,
      pipelineDef,
      demand: phaseCtx.demand,
    };

    bindTrackerToRecord(ctx);
    await executePhaseLoop(ctx, deps, createMockGitOperations() as any, createMockWtPlan());

    expect(deps.getPortsForIssue).toHaveBeenCalledWith(42);
    expect(deps.isPreviewRunning).toHaveBeenCalledWith(42);
    expect(deps.startPreviewServers).toHaveBeenCalledWith(wtCtx, issue);
    expect(phaseCtx.ports).toEqual(MOCK_PORTS);
  });

  it('does not attempt port restore when starting from phase 0', async () => {
    const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
    const issue = createTestIssue();
    const wtCtx = createMockWtCtx();

    const phaseCtx: PhaseContext = {
      demand: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' }, title: 'Test', description: 'desc' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
    };

    const deps = buildDeps();

    const ctx: IssueProcessingContext = {
      issue, branchName: 'feat/issue-42', wtCtx, phaseCtx,
      record: {
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Pending,
        pipelineMode: 'plan-mode',
        attempts: 0,
      } as any,
      isRetry: false,
      pipelineDef,
      demand: phaseCtx.demand,
    };

    // Plan phase executes, then hits review gate and pauses
    bindTrackerToRecord(ctx);
    await executePhaseLoop(ctx, deps, createMockGitOperations() as any, createMockWtPlan());

    expect(deps.getPortsForIssue).not.toHaveBeenCalled();
    expect(phaseCtx.ports).toBeUndefined();
  });

  it('已有端口且预览仍在运行时复用端口', async () => {
    const pipelineDef = buildPlanModePipeline({ e2eEnabled: true });
    const issue = createTestIssue();
    const wtCtx = createMockWtCtx();

    const preExistingPorts: PortPair = { backendPort: 5555, frontendPort: 9999 };
    const phaseCtx: PhaseContext = {
      demand: { demandId: 'gh-42', sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' }, title: 'Test', description: 'desc' },
      branchName: 'feat/issue-42',
      pipelineMode: 'plan-mode',
      ports: preExistingPorts,
    };

    const deps = buildDeps({
      getPortsForIssue: vi.fn().mockReturnValue(MOCK_PORTS),
      isPreviewRunning: vi.fn().mockReturnValue(true),
    });

    const ctx: IssueProcessingContext = {
      issue, branchName: 'feat/issue-42', wtCtx, phaseCtx,
      record: {
        issueIid: 42,
        branchName: 'feat/issue-42',
        state: IssueState.Failed,
        failedAtState: IssueState.PhaseRunning,
        currentPhase: 'uat',
        pipelineMode: 'plan-mode',
        attempts: 1,
      } as any,
      isRetry: true,
      pipelineDef,
      demand: phaseCtx.demand,
    };

    bindTrackerToRecord(ctx);
    await executePhaseLoop(ctx, deps, createMockGitOperations() as any, createMockWtPlan());

    expect(deps.getPortsForIssue).not.toHaveBeenCalled();
    expect(phaseCtx.ports).toEqual(preExistingPorts);
  });
});

describe('restartPreview port key consistency', () => {
  it('PortPairRecord uses backendPort/frontendPort keys', () => {
    const ports: PortPair = { backendPort: 4001, frontendPort: 9001 };
    expect(ports).toHaveProperty('backendPort');
    expect(ports).toHaveProperty('frontendPort');
    expect(ports).not.toHaveProperty('frontend');
    expect(ports).not.toHaveProperty('backend');
  });
});
