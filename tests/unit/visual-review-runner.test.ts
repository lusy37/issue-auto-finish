import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { VISUAL_REVIEW_OUTPUT_SCHEMA, VisualReviewRunner } from '../../src/e2e/VisualReviewRunner.js';
import { collectScreenshotEvidence, validateEvidenceCoverage, visualCasesPath } from '../../src/e2e/VisualEvidence.js';
import type { AIRunner } from '../../src/ai-runner/AIRunner.js';
import type { ScreenshotEvidence } from '../../src/shared/workbench.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-visual-review-'));
  temporaryRoots.push(root);
  const runId = '11111111-1111-4111-8111-111111111111';
  const artifactDir = path.join(root, 'uat', runId, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(path.join(artifactDir, 'login.png'), bytes);
  const evidence: ScreenshotEvidence = {
    id: 'shot-001', path: 'artifacts/login.png', sha256: createHash('sha256').update(bytes).digest('hex'),
    testId: 'login', projectName: 'chromium', caseId: 'login-desktop', sceneId: 'login',
    viewport: { width: 1440, height: 900 }, pageUrl: 'http://localhost/login', acceptanceRefs: ['task:login:0'],
  };
  return { root, runId, evidence: [evidence] };
}

function runner(output: unknown): AIRunner {
  return {
    run: vi.fn().mockResolvedValue({ success: true, output: JSON.stringify(output), exitCode: 0 }),
    killAll: vi.fn(),
    killByWorkDir: vi.fn().mockReturnValue(0),
  };
}

describe('视觉复核运行器', () => {
  it.each(['clear', 'uncertain'] as const)('覆盖缺口不会掩盖 %s 观察结果', async (assessment) => {
    const { root, runId, evidence } = fixture();
    const airunner = runner({
      summary: '缺少加载状态',
      screenshots: [{ id: 'image-001', assessment, reason: '当前画面观察', issues: [] }],
      coverageGaps: [{
        description: '缺少加载状态', kind: 'missing-visible-state',
        acceptanceRefs: ['task:login:0'], caseId: 'login-desktop', sceneId: 'login',
        viewport: { width: 1440, height: 900 }, screenshotIds: [],
      }],
    });
    const result = await new VisualReviewRunner().run({
      runner: airunner, dataDir: root, runId, issueIid: 1,
      policy: { visualReviewEnabled: true, maxImages: 1, timeoutMs: 1000 }, evidence,
      cases: [{
        id: 'login-desktop', sceneId: 'login', acceptanceRefs: ['task:login:0'],
        viewports: [{ width: 1440, height: 900 }], expectedState: '登录表单可见',
      }],
      acceptanceText: '登录页面可用',
    });
    expect(result).toMatchObject({
      status: 'needs-review',
      reasonCode: assessment === 'clear' ? 'visual-coverage-gaps' : 'visual-review-incomplete',
    });
  });

  it('视觉用例清单按 Issue 保存在工作台数据目录', () => {
    expect(visualCasesPath('E:/runtime', 20)).toBe(path.join('E:/runtime', 'issues', '20', 'uat', 'visual-cases.json'));
  });

  it('重复截图 ID 和场景视口不能作为完整视觉证据', () => {
    const { evidence } = fixture();
    const cases = [{ id: 'login-desktop', sceneId: 'login', acceptanceRefs: ['task:login:0'],
      viewports: [{ width: 1440, height: 900 }], expectedState: '登录表单可见' }];
    const gaps = validateEvidenceCoverage(cases, [evidence[0], { ...evidence[0] }], 12);
    expect(gaps.map(item => item.description)).toContain('截图 ID 重复：shot-001');
    expect(gaps.some(item => item.description.startsWith('截图场景与视口重复'))).toBe(true);
  });

  it('只把服务端选定图片传给 AIRunner，并把 clear 聚合为通过', async () => {
    const { root, runId, evidence } = fixture();
    const airunner = runner({ summary: '截图清晰', screenshots: [{ id: 'image-001', assessment: 'clear', reason: '页面完整可见', issues: [] }], coverageGaps: [] });
    const result = await new VisualReviewRunner().run({
      runner: airunner, dataDir: root, runId, issueIid: 1,
      policy: { visualReviewEnabled: true, maxImages: 1, timeoutMs: 1000 }, evidence,
      cases: [{ id: 'login-desktop', sceneId: 'login', acceptanceRefs: ['task:login:0'], viewports: [{ width: 1440, height: 900 }], expectedState: '登录表单可见' }],
      acceptanceText: '登录页面可用',
      testContext: {
        playwright: { playwrightExitCode: 0, reportValid: true, passedTests: 12, failedTests: 0, skippedTests: 0, reportErrors: [] },
        verify: { commit: 'abc123', completedAt: '2026-10-02T15:00:00.000Z', reportMarkdown: '# 验证报告\n单元测试通过' },
      },
    });
    expect(result.status).toBe('passed');
    expect(result.checkedScreenshots).toEqual(['shot-001']);
    const options = vi.mocked(airunner.run).mock.calls[0][0];
    expect(options.imagePaths).toHaveLength(1);
    expect(options.imagePaths?.[0]).toContain(`${path.sep}image-001.png`);
    expect(options.outputSchema).toEqual(VISUAL_REVIEW_OUTPUT_SCHEMA);
    expect(options.prompt).toContain('点击后的计算逻辑、状态转换、接口行为和边界条件由单元、集成或 Playwright 测试验证');
    expect(options.prompt).toContain('不得仅因静态截图无法证明动态逻辑而返回 uncertain');
    expect(options.prompt).toContain('"passedTests":12');
    expect(options.prompt).toContain('abc123');
    expect(fs.readdirSync(path.join(root, 'visual-review-tmp', runId))).toHaveLength(0);
  });

  it('证据采集只采用带元数据的视觉附件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-visual-evidence-'));
    temporaryRoots.push(root);
    const runId = '22222222-2222-4222-8222-222222222222';
    const outputDir = path.join(root, 'uat', runId);
    const artifactsDir = path.join(outputDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const metadata = {
      caseId: 'login-desktop', sceneId: 'login', viewport: { width: 1440, height: 900 },
      pageUrl: 'http://localhost/login', acceptanceRefs: ['task:login:0'],
    };
    const report = {
      suites: [{ specs: [
        { id: 'ordinary', title: '普通截图', tests: [{ expectedStatus: 'passed', status: 'expected', projectName: 'chromium', results: [{ attachments: [{ name: 'screenshot', contentType: 'image/png', path: path.join(artifactsDir, 'ordinary.png') }] }] }] },
        { id: 'visual', title: '视觉截图', tests: [{ expectedStatus: 'passed', status: 'expected', projectName: 'chromium', results: [{ attachments: [
          { name: 'iaf-visual', contentType: 'image/png', body: bytes.toString('base64') },
          { name: 'iaf-visual-meta', contentType: 'application/json', body: Buffer.from(JSON.stringify(metadata)).toString('base64') },
        ] }] }] },
      ] }],
      stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
    };

    const collected = collectScreenshotEvidence(report, outputDir);
    expect(collected.errors).toEqual([]);
    expect(collected.evidence).toHaveLength(1);
    expect(collected.evidence[0].path).toBe('artifacts/iaf-visual-001.png');
    expect(fs.existsSync(path.join(outputDir, collected.evidence[0].path))).toBe(true);
  });

  it('必需证据超过图片上限时不调用模型', async () => {
    const { root, runId, evidence } = fixture();
    const airunner = runner({ summary: '', screenshots: [], coverageGaps: [] });
    const result = await new VisualReviewRunner().run({
      runner: airunner, dataDir: root, runId, issueIid: 1,
      policy: { visualReviewEnabled: true, maxImages: 0, timeoutMs: 1000 }, evidence,
      cases: [{ id: 'login-desktop', sceneId: 'login', acceptanceRefs: ['task:login:0'], viewports: [{ width: 1440, height: 900 }], expectedState: '登录表单可见' }],
      acceptanceText: '登录页面可用',
    });
    expect(result.status).toBe('needs-review');
    expect(airunner.run).not.toHaveBeenCalled();
  });
});
