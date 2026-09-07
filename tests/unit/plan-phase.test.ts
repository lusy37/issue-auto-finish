import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanPhase } from '../../src/phases/PlanPhase.js';
import { BuildPhase } from '../../src/phases/BuildPhase.js';
import { PlanPersistence } from '../../src/persistence/PlanPersistence.js';
import type { PhaseContext } from '../../src/phases/BasePhase.js';
import type { DemandSpec } from '../../src/demand/DemandSpec.js';
import {
  createMockAIRunner,
  createMockGitOperations,
  createTestConfig,
} from '../helpers/mock-factories.js';

function createTestDemand(overrides?: Partial<DemandSpec>): DemandSpec {
  return {
    demandId: 'gh-42',
    sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
    title: 'Test Issue',
    description: 'Test description',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PlanPhase', () => {
  let tmpDir: string;
  let plan: PlanPersistence;
  let aiRunner: ReturnType<typeof createMockAIRunner>;
  let phase: PlanPhase;

  const ctx: PhaseContext = {
    demand: createTestDemand(),
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-phase-test-'));
    plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    aiRunner = createMockAIRunner();

    phase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig(),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses planPrompt when no review feedback exists', () => {
    const prompt = (phase as any).buildPrompt(ctx);
    expect(prompt).toContain('一次性完成需求分析和方案设计');
    expect(prompt).not.toContain('审核反馈');
  });

  it('uses rePlanPrompt when review feedback exists', () => {
    plan.writeReviewFeedback('方案中缺少对性能的考虑，请补充负载测试方案。');

    const prompt = (phase as any).buildPrompt(ctx);
    expect(prompt).toContain('审核反馈');
    expect(prompt).toContain('方案中缺少对性能的考虑');
    expect(prompt).not.toContain('一次性完成需求分析和方案设计');
  });

  it('includes supplement text in rePlan prompt', () => {
    plan.writeReviewFeedback('请增加错误处理');

    const ctxWithSupplement: PhaseContext = {
      ...ctx,
      demand: createTestDemand({
        supplement: { freeText: '补充需求：支持批量操作' },
      }),
    };
    const prompt = (phase as any).buildPrompt(ctxWithSupplement);
    expect(prompt).toContain('补充需求：支持批量操作');
    expect(prompt).toContain('请增加错误处理');
  });

  it('does NOT prepend fallback when runner has native plan mode (claude)', () => {
    const claudePhase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig({ ai: { mode: 'codex', binary: 'codex', phaseTimeoutMs: 1800000, nvmNodeVersion: '20' } }),
    );
    const prompt = (claudePhase as any).buildPrompt(ctx);
    expect(prompt).not.toContain('技术架构师');
    expect(prompt).toContain('一次性完成需求分析和方案设计');
  });

  // ── claude 驳回重规划：被驳回方案 snapshot 必须进入 prompt ──
  //
  // 背景:claude --mode plan 下 Write 工具被禁,AI 不会主动 Read 01-plan.md,
  // 若 prompt 不含旧方案上下文,会输出与原方案差异极小的新方案。本组用例锁定
  // "snapshot 必须注入 + 强化实质修改指令"这一关键契约。

  it('claude + reject feedback (with planSnapshot): injects rejected plan into prompt', () => {
    const oldPlan = '# 旧方案标题\n\n这是被驳回的实施计划全文,需要被注入 prompt 让 AI 看到。';
    const feedback = '缺少错误处理与权限校验';
    plan.writeReviewFeedback(feedback, oldPlan);

    const claudePhase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig({ ai: { mode: 'codex', binary: 'codex', phaseTimeoutMs: 1800000, nvmNodeVersion: '20' } }),
    );
    const prompt = (claudePhase as any).buildPrompt(ctx);

    expect(prompt).toContain('<rejected-plan>');
    expect(prompt).toContain('</rejected-plan>');
    expect(prompt).toContain(oldPlan);
    expect(prompt).toContain('上一轮被驳回的实施计划');
    expect(prompt).toContain(feedback);
    expect(prompt).toContain('实质性修改');
    expect(prompt).not.toContain('一次性完成需求分析和方案设计');
  });

  it('claude + multi-round reject: only injects the LATEST snapshot (avoid stale plans)', () => {
    plan.writeReviewFeedback('round-1 反馈', '# 第一版方案\n\n旧方案 V1 占位文本');
    plan.writeReviewFeedback('round-2 反馈', '# 第二版方案\n\n旧方案 V2 占位文本');

    const claudePhase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig({ ai: { mode: 'codex', binary: 'codex', phaseTimeoutMs: 1800000, nvmNodeVersion: '20' } }),
    );
    const prompt = (claudePhase as any).buildPrompt(ctx);

    expect(prompt).toContain('第二版方案');
    expect(prompt).toContain('旧方案 V2');
    expect(prompt).not.toContain('第一版方案');
    expect(prompt).not.toContain('旧方案 V1');
    expect(prompt).toContain('round-1 反馈');
    expect(prompt).toContain('round-2 反馈');
  });

  it('claude + oversized planSnapshot: truncates to MAX_CHARS with explicit notice', () => {
    const huge = '占位文本'.repeat(3000); // 远超 8000 字符上限
    plan.writeReviewFeedback('过长方案反馈', huge);

    const claudePhase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig({ ai: { mode: 'codex', binary: 'codex', phaseTimeoutMs: 1800000, nvmNodeVersion: '20' } }),
    );
    const prompt = (claudePhase as any).buildPrompt(ctx);

    expect(prompt).toContain('<rejected-plan>');
    expect(prompt).toMatch(/已截断至\s*8000\s*字符/);
    // 注入的 snapshot 部分长度不会超过上限(单独验证占位文本无需精确匹配)
    const match = prompt.match(/<rejected-plan>\n([\s\S]*?)\n<\/rejected-plan>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(8000);
  });

  it('claude + reject feedback (with planSnapshot): also injects snapshot (PTY profile triggers deterministicCopy path)', () => {
    // claude 当前的 PTY profile 有 modeCycleKey + planModeName,
    // 因此 usesDeterministicPlanCopy 返回 true,同样走 snapshot 注入路径。
    // 本测试锁定该行为,防止后续 ptyProfile 调整误伤注入逻辑。
    const oldPlan = '# claude 路径下的旧方案\n\n这份方案应同样被注入 prompt';
    plan.writeReviewFeedback('请补充错误处理', oldPlan);

    const prompt = (phase as any).buildPrompt(ctx);

    expect(prompt).toContain('<rejected-plan>');
    expect(prompt).toContain(oldPlan);
    expect(prompt).toContain('请补充错误处理');
    expect(prompt).toContain('实质性修改');
  });
});

describe('Phase artifact validation', () => {
  let tmpDir: string;
  let plan: PlanPersistence;
  let aiRunner: ReturnType<typeof createMockAIRunner>;

  const ctx: PhaseContext = {
    demand: {
      demandId: 'gh-42',
      sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
      title: 'Test Issue',
      description: 'Test description',
      createdAt: '2024-01-01T00:00:00Z',
    },
    branchName: 'feat/issue-42',
    pipelineMode: 'plan-mode',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-validation-test-'));
    plan = new PlanPersistence(tmpDir, 42);
    plan.ensureDir();
    aiRunner = createMockAIRunner();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PlanPhase returns failed when AI succeeds but 01-plan.md is missing', async () => {
    const phase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig(),
    );

    const intent = await phase.run(ctx);
    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/计划内容为空或不完整/);
  });

  it('PlanPhase returns failed when 01-plan.md exists but is too small', async () => {
    const planDir = path.join(tmpDir, '.claude-plan', 'issue-42');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, '01-plan.md'), 'tiny');

    const phase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig(),
    );

    const intent = await phase.run(ctx);
    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/计划内容为空或不完整/);
  });

  it('PlanPhase succeeds when 01-plan.md has sufficient content', async () => {
    const planDir = path.join(tmpDir, '.claude-plan', 'issue-42');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, '01-plan.md'),
      '# Plan\n\nThis is a detailed implementation plan with enough content to pass validation.\n',
    );

    const phase = new PlanPhase(
      aiRunner,
      createMockGitOperations() as any,
      plan,
      createTestConfig(),
    );

    aiRunner.run.mockResolvedValue({success:true,output:'# 计划\n\n'+'实施步骤及验收标准。'.repeat(10),exitCode:0});
    const intent = await phase.run(ctx);
    expect(intent.kind).toBe('completed');
  });

  it('BuildPhase returns failed when AI succeeds but no git changes', async () => {
    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(false);

    const buildPhase = new BuildPhase(
      aiRunner,
      git as any,
      plan,
      createTestConfig(),
    );

    const intent = await buildPhase.run(ctx);
    expect(intent.kind).toBe('failed');
    if (intent.kind !== 'failed') throw new Error('Expected failed intent');
    expect(intent.error.message).toMatch(/未产生任何代码变更/);
  });

  it('BuildPhase succeeds when git has changes', async () => {
    const git = createMockGitOperations();
    git.hasChanges.mockResolvedValue(true);

    const buildPhase = new BuildPhase(
      aiRunner,
      git as any,
      plan,
      createTestConfig(),
    );

    const intent = await buildPhase.run(ctx);
    expect(intent.kind).toBe('completed');
  });
});
