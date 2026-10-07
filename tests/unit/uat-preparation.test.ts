import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUatWriteDirectory, prepareUat, validateUatPreparation } from '../../src/e2e/UatPreparation.js';
import { visualCasesPath } from '../../src/e2e/VisualEvidence.js';
import type { TaskPlan } from '../../src/dag/contracts.js';
import type { VisualCasesManifest } from '../../src/shared/workbench.js';
import { createMockAIRunner, createTestConfig } from '../helpers/mock-factories.js';
import { PLAN_FORMAT } from '../../src/shared/runtime/formats.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'UAT 准备契约 ')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const workDir = path.join(root, 'worktree'), dataDir = path.join(root, 'runtime');
  fs.mkdirSync(workDir);
  const config = createTestConfig(); config.e2e.visualReviewEnabled = true;
  const demand = {
    demandId: 'gh-1', title: '筛选看板', description: '组合筛选', createdAt: '2026-10-06T00:00:00Z',
    sourceRef: { source: 'github-issue' as const, displayId: '1', externalId: '1' },
  };
  const plan: TaskPlan = {
    format: PLAN_FORMAT, issueNumber: 1, revision: 1, demand, createdAt: demand.createdAt,
    digest: 'approved-plan', title: demand.title, description: demand.description,
    acceptanceCriteria: ['筛选结果正确'], tasks: [{
      id: 'board', title: '看板', instructions: '实现看板', dependsOn: [], acceptanceCriteria: ['移动端可用'],
    }],
  };
  const manifest: VisualCasesManifest = {
    format: 'iaf-mini/visual-cases/v1', planDigest: plan.digest,
    cases: [{ id: 'board-mobile', sceneId: 'filtered', acceptanceRefs: ['plan:0', 'task:board:0'],
      viewports: [{ width: 375, height: 812 }], expectedState: '筛选结果与条件可见' }],
  };
  const file = visualCasesPath(dataDir, 1);
  const writeConfig = () => fs.writeFileSync(path.join(workDir, config.e2e.configFile), 'export default {};');
  const writeManifest = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest));
  };
  return { workDir, dataDir, issueIid: 1, plan, demand, ai: config.ai, e2e: config.e2e,
    manifest, file, writeConfig, writeManifest };
}

describe('UAT 准备文件与写目录契约', () => {
  it('配置和清单都有效时复用文件，不重复调用 AI', async () => {
    const f = fixture(); f.writeConfig(); f.writeManifest();
    const runner = createMockAIRunner();
    const result = await prepareUat({ ...f, runner });
    expect(result.cases).toEqual(f.manifest);
    expect(result.acceptance.size).toBe(2);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('只授权本 Issue 目录，准备完成后校验实际落盘的文件', async () => {
    const f = fixture(), runner = createMockAIRunner();
    vi.mocked(runner.run).mockImplementation(async options => {
      expect(options).toMatchObject({ mode: 'agent', purpose: 'uat-prepare', workDir: f.workDir });
      expect(options.additionalDirectories).toEqual([path.dirname(f.file)]);
      expect(options.prompt).toContain(f.file);
      expect(options.sessionId).toBeUndefined();
      f.writeConfig(); f.writeManifest();
      return { success: true, exitCode: 0, output: '已写入' };
    });
    expect((await prepareUat({ ...f, runner })).cases).toEqual(f.manifest);
    expect(fs.existsSync(path.join(f.dataDir, 'issues', '2'))).toBe(false);
  });

  it('AI 返回成功但没有清单时不能通过准备', async () => {
    const f = fixture(); f.writeConfig();
    const runner = createMockAIRunner();
    await expect(prepareUat({ ...f, runner })).rejects.toThrow(f.file);
  });

  it.each(['过期计划', '重复编号', '未知验收引用', '重复视口', '空场景', '格式错误', 'JSON 损坏'])(
    '%s 清单必须在准备阶段被修复，不能只比较摘要', async name => {
      const f = fixture(); f.writeConfig();
      const valid = JSON.stringify(f.manifest);
      if (name === '过期计划') f.manifest.planDigest = 'old-plan';
      if (name === '重复编号') f.manifest.cases.push({ ...f.manifest.cases[0] });
      if (name === '未知验收引用') f.manifest.cases[0].acceptanceRefs = ['plan:999'];
      if (name === '重复视口') f.manifest.cases[0].viewports.push({ width: 375, height: 812 });
      if (name === '空场景') f.manifest.cases = [];
      f.writeManifest();
      if (name === '格式错误') fs.writeFileSync(f.file, '{}');
      if (name === 'JSON 损坏') fs.writeFileSync(f.file, '{');
      expect(() => validateUatPreparation(f)).toThrow('UAT 准备文件缺失或无效');
      const runner = createMockAIRunner();
      vi.mocked(runner.run).mockImplementation(async () => {
        fs.writeFileSync(f.file, valid);
        return { success: true, exitCode: 0, output: '已修复' };
      });
      expect((await prepareUat({ ...f, runner })).cases?.planDigest).toBe(f.plan.digest);
      expect(runner.run).toHaveBeenCalledOnce();
    },
  );

  it('关闭视觉复核时只要求配置，不授予数据目录写权限', async () => {
    const f = fixture(); f.e2e.visualReviewEnabled = false;
    const runner = createMockAIRunner();
    vi.mocked(runner.run).mockImplementation(async options => {
      expect(options.additionalDirectories).toBeUndefined();
      expect(options.prompt).not.toContain('IAF_VISUAL_CASES_FILE');
      f.writeConfig();
      return { success: true, exitCode: 0, output: '已写入配置' };
    });
    expect((await prepareUat({ ...f, runner })).cases).toBeUndefined();
    expect(fs.existsSync(f.dataDir)).toBe(false);
  });

  it('拒绝经过其他目录的链接来授予写权限', () => {
    const f = fixture(), outside = path.join(root, 'other-issue');
    fs.mkdirSync(f.dataDir); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.dataDir, 'issues'), 'junction');
    expect(() => ensureUatWriteDirectory(f.dataDir, 1)).toThrow('不能经过链接');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
