/**
 * verify-fix loop 端到端集成测试 — 复现 + 验证 issue-179 现象
 *
 * 场景：verify 阶段读取真实的 verify-report.md（含 Todolist 未全部完成），
 * 输出 RequestRetryFromIntent + context.verifyFailures/rawReport。
 * 编排器把 context 透传给下一轮的 BuildPhase，让 BuildPhase 拼接出
 * **包含具体失败原因和原始报告**的修复 prompt。
 *
 * 这是 PR3/PR4 重构后的回归测试。重构前 verifyFailures 永远是 []，
 * 导致 AI 在 build 修复阶段不知道要修什么，Todolist 一直 0/N，最终
 * verify-fix loop 跑满 3 轮后 fail-pipeline（issue-179 的现象）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Orchestrator,
  buildPipeline,
  PLAN_MODE_TRANSITIONS,
  type OrchestrationState,
  type OrchestrationStateSnapshot,
  type OrchestrationTransition,
  type OrchestratorStateStore,
  type PhaseHistoryEntry,
  type PhaseIntent,
  type PhaseRunner,
  type PhaseSpec,
  type ReducerSideEffect,
  type SideEffectExecutor,
} from '../../src/orchestration/index.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import { VerifyPhase } from '../../src/phases/VerifyPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import {
  ScriptedAIRunner,
  successScript,
  writeArtifact,
} from '../helpers/scripted-ai-runner.js';
import { createMockGitOperations, createTestConfig } from '../helpers/mock-factories.js';

vi.mock('../../src/knowledge/index.js', () => ({
  getProjectKnowledge: vi.fn().mockReturnValue(null),
}));

let mockDataDir: string;
vi.mock('../../src/paths.js', () => ({
  resolveDataDir: () => mockDataDir,
}));

const ISSUE_IID = 179;
const FAILING_REPORT = [
  '# 验证报告',
  '',
  '**Lint 结果**: 失败',
  '**Build 结果**: 通过',
  '**Test 结果**: 通过',
  '',
  '## Todolist 检查: 0/18 项完成',
  '',
  '## 失败详情',
  '- ESLint 报告 5 处 no-unused-vars 错误',
  '- 待办列表中所有 18 项均未勾选',
  '',
  '## 总结',
  '验证失败，请先修复 Lint 并完成 Todolist。',
].join('\n');

const PASSING_REPORT = [
  '# 验证报告',
  '',
  '**Lint 结果**: 通过',
  '**Build 结果**: 通过',
  '**Test 结果**: 通过',
  '',
  '## Todolist 检查: 18/18 项完成',
  '',
  '## 总结',
  '所有检查项均通过。',
].join('\n');

// 模拟状态存储 — 真实记录 history / state，但不依赖文件持久化
function makeStateStore(): OrchestratorStateStore & {
  getCurrentState(): OrchestrationState;
  history: PhaseHistoryEntry[];
} {
  let state: OrchestrationState = { kind: 'queued' };
  const history: PhaseHistoryEntry[] = [];
  let attempts = 0;
  return {
    getSnapshot(): OrchestrationStateSnapshot {
      return { state, history: [...history], attempts };
    },
    transitionToRunning(_iid: number, phaseId: string) {
      state = { kind: 'running', phaseId };
    },
    applyTransition(_iid: number, transition: OrchestrationTransition) {
      state = transition.nextState;
      attempts = transition.nextAttempts;
      history.push(transition.historyEntry);
    },
    getCurrentState() {
      return state;
    },
    history,
  };
}

function makeNoopExecutor(): SideEffectExecutor & { effects: ReducerSideEffect[] } {
  const effects: ReducerSideEffect[] = [];
  return {
    async execute(_iid, _phaseId, effect) {
      effects.push(effect);
    },
    effects,
  };
}

describe('verify-fix loop 端到端：context 透传到 BuildPhase prompt', () => {
  let dataDir: string;
  let wtPlan: PlanPersistence;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'verify-fix-e2e-'));
    mockDataDir = mkdtempSync(path.join(tmpdir(), 'verify-fix-e2e-global-'));
    wtPlan = new PlanPersistence(dataDir, ISSUE_IID);
    wtPlan.ensureDir();
    // build 阶段需要的 .claude-plan 目录
    mkdirSync(path.join(dataDir, '.claude-plan', `issue-${ISSUE_IID}`), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(mockDataDir, { recursive: true, force: true });
  });

  it('修复迭代时 BuildPhase 真实 prompt 必须包含 verify 报告中的失败原因和原始报告', async () => {
    // ── ScriptedAIRunner 编排 4 次调用：build1 → verify1(fail) → build2 → verify2(pass) ──
    const runner = new ScriptedAIRunner([
      successScript({ output: 'build done' }),
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', FAILING_REPORT)),
      successScript({ output: 'fix applied' }),
      successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', PASSING_REPORT)),
    ]);

    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(true);
    const config = createTestConfig({ verifyFixLoop: { enabled: true, maxIterations: 3, todolistCheckEnabled: true } });

    // 真实 Phase 实例（不 stub）
    const buildPhase = new BuildPhase(runner as any, git as any, wtPlan, config);
    const verifyPhase = new VerifyPhase(runner as any, git as any, wtPlan, config);

    // 用 PhaseRunner 接口把真实 Phase 装起来，让 Orchestrator 调度
    const phaseRunner: PhaseRunner = {
      async run(spec: PhaseSpec, ctx): Promise<PhaseIntent> {
        const phaseCtx = {
          demand: {
            demandId: String(ISSUE_IID),
            title: 'Test Issue',
            description: 'Fix verify failures',
            sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
          },
          branchName: `feat/issue-${ISSUE_IID}`,
          pipelineMode: 'plan-mode',
          fixContext: ctx.fixIteration && ctx.fixIteration > 0 ? {
            iteration: ctx.fixIteration,
            verifyFailures: [...(ctx.verifyFailures ?? [])],
            rawReport: ctx.rawReport ?? '',
          } : undefined,
        };
        if (spec.id === 'build') return buildPhase.run(phaseCtx);
        if (spec.id === 'verify') return verifyPhase.run(phaseCtx);
        if (spec.id === 'review') return { kind: 'completed', output: 'auto-approved' };
        return { kind: 'completed', output: `${spec.id} skipped` };
      },
    };

    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();
    const orchestrator = new Orchestrator(pipeline, phaseRunner, stateStore, executor, {
      onGateWaiting: () => ({ action: 'approve' }),
    });

    await orchestrator.drive(ISSUE_IID, {
      issueIid: ISSUE_IID,
      demand: {},
      branchName: `feat/issue-${ISSUE_IID}`,
      workDir: dataDir,
    });

    // ── 断言 1：流水线最终成功 ──
    expect(stateStore.getCurrentState().kind).toBe('pipeline-completed');

    // ── 断言 2：runner 收到 4 次调用（2 build + 2 verify） ──
    expect(runner.runCalls).toHaveLength(4);

    // ── 断言 3：第一次 build 的 prompt 不包含修复模式标题 ──
    const firstBuildPrompt = runner.runCalls[0].prompt;
    expect(firstBuildPrompt).not.toContain('修复模式');

    // ── 断言 4：第二次 build 的 prompt 必须包含修复指令 + 真实失败原因 + 真实原始报告 ──
    const secondBuildPrompt = runner.runCalls[2].prompt;
    expect(secondBuildPrompt).toContain('修复模式（第 1 轮修复）');
    // verifyFailures 通过 VerifyReportParser 解析得到的具体失败原因
    expect(secondBuildPrompt).toContain('Lint 检查失败');
    expect(secondBuildPrompt).toContain('Todolist 未全部完成(0/18)');
    // rawReport 透传原始验证报告内容
    expect(secondBuildPrompt).toContain('## Todolist 检查: 0/18 项完成');
    expect(secondBuildPrompt).toContain('ESLint 报告 5 处 no-unused-vars 错误');

    // ── 断言 5：history 中保存了 retryFromContext ──
    const verifyRetryEntries = stateStore.history.filter(
      (h) => h.phaseId === 'verify' && h.outcome === 'retried-from',
    );
    expect(verifyRetryEntries).toHaveLength(1);
    expect(verifyRetryEntries[0].retryFromContext?.verifyFailures).toContain('Lint 检查失败');
    expect(verifyRetryEntries[0].retryFromContext?.verifyFailures).toContain('Todolist 未全部完成(0/18)');
    expect(verifyRetryEntries[0].retryFromContext?.rawReport).toContain('Todolist 检查: 0/18');
  });

  it('verify-fix loop 跑满 maxIterations(3) 后 → pipeline-failed manual（避免 issue-179 的无限重试现象）', async () => {
    // ── 始终失败：4 次 build + 4 次 verify（前 3 次 verify 都报 fail，第 4 次不应该被调用） ──
    const scripts = [];
    for (let i = 0; i < 4; i++) {
      scripts.push(successScript({ output: `build attempt ${i + 1}` }));
      scripts.push(successScript(undefined, writeArtifact(ISSUE_IID, '02-verify-report.md', FAILING_REPORT)));
    }
    const runner = new ScriptedAIRunner(scripts);
    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(true);
    const config = createTestConfig({ verifyFixLoop: { enabled: true, maxIterations: 3, todolistCheckEnabled: true } });

    const buildPhase = new BuildPhase(runner as any, git as any, wtPlan, config);
    const verifyPhase = new VerifyPhase(runner as any, git as any, wtPlan, config);

    const phaseRunner: PhaseRunner = {
      async run(spec: PhaseSpec, ctx): Promise<PhaseIntent> {
        const phaseCtx = {
          demand: {
            demandId: String(ISSUE_IID),
            title: 'Test Issue',
            description: 'Always fails',
            sourceRef: { displayId: String(ISSUE_IID), source: 'github' as const, externalId: '200' },
          },
          branchName: `feat/issue-${ISSUE_IID}`,
          pipelineMode: 'plan-mode',
          fixContext: ctx.fixIteration && ctx.fixIteration > 0 ? {
            iteration: ctx.fixIteration,
            verifyFailures: [...(ctx.verifyFailures ?? [])],
            rawReport: ctx.rawReport ?? '',
          } : undefined,
        };
        if (spec.id === 'build') return buildPhase.run(phaseCtx);
        if (spec.id === 'verify') return verifyPhase.run(phaseCtx);
        if (spec.id === 'review') return { kind: 'completed', output: 'auto-approved' };
        return { kind: 'completed', output: `${spec.id} skipped` };
      },
    };

    const pipeline = buildPipeline({ release: false, e2e: false }, PLAN_MODE_TRANSITIONS);
    const stateStore = makeStateStore();
    const executor = makeNoopExecutor();
    const orchestrator = new Orchestrator(pipeline, phaseRunner, stateStore, executor, {
      maxIterations: 50,
      onGateWaiting: () => ({ action: 'approve' }),
    });

    await orchestrator.drive(ISSUE_IID, {
      issueIid: ISSUE_IID,
      demand: {},
      branchName: `feat/issue-${ISSUE_IID}`,
      workDir: dataDir,
    });

    const final = stateStore.getCurrentState();
    expect(final.kind).toBe('pipeline-failed');
    if (final.kind === 'pipeline-failed') {
      expect(final.retryable).toBe('manual');
      expect(final.failedAt).toBe('verify');
      expect(final.error?.message).toMatch(/retry-from loop exhausted/);
    }

    // verify 共调用 4 次：3 次失败回退 build + 第 4 次触发 maxIterations 上限
    const verifyEntries = stateStore.history.filter((h) => h.phaseId === 'verify');
    expect(verifyEntries.length).toBeLessThanOrEqual(4);
    const retryEntries = verifyEntries.filter((h) => h.outcome === 'retried-from');
    expect(retryEntries.length).toBe(3);
  });
});
