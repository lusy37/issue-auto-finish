import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock i18n to load the real zh-CN locale
vi.mock('../../../src/i18n/index.js', async () => {
  const { zhCN } = await import('../../../src/i18n/locales/zh-CN.js');
  const messages = new Map<string, Record<string, string>>();
  messages.set('zh-CN', zhCN);

  function t(key: string, params?: Record<string, string | number>): string {
    const msgs = messages.get('zh-CN');
    if (!msgs) return key;
    let text = msgs[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  }

  return {
    t,
    setLocale: vi.fn(),
    getLocale: () => 'zh-CN' as const,
    registerLocale: vi.fn(),
  };
});

// Mock the knowledge module to return deterministic defaults
vi.mock('../../../src/knowledge/index.js', () => {
  const KNOWLEDGE_DEFAULTS = {
    version: 1,
    generatedAt: '2024-01-01T00:00:00Z',
    repoPath: '',
    structure: {
      primaryLanguage: 'TypeScript',
      frameworks: ['Node.js'],
      isMonorepo: false,
      hasFrontendBackendSplit: true,
      frontendDir: 'frontend',
      e2eDir: 'frontend/e2e/dynamic',
      e2eTool: 'Playwright',
    },
    toolchain: {
      packageManager: 'pnpm',
      installCommand: 'pnpm install --frozen-lockfile',
      installFallbackCommand: 'pnpm install --frozen-lockfile --ignore-scripts',
      lintCommand: 'pnpm run lint',
      buildCommand: 'pnpm run build',
      testCommand: 'pnpm test',
      testFilesCommand: 'pnpm test4vscode --files {files}',
      dependencyCheckPath: 'node_modules/.bin/eslint',
    },
    codeStyle: {
      indentStyle: 'spaces' as const,
      indentSize: 2,
      lineWidth: 120,
    },
    businessContext: {
      purpose: '',
      targetUsers: '',
      domain: '',
      coreFeatures: [],
    },
    architecture: {
      overview: '',
      keyModules: [],
      dataFlow: '',
      designPatterns: [],
      externalDependencies: [],
    },
    domainConcepts: [],
    agentKnowledge: {
      summary: '',
      cursorRules: [],
      conventions: [],
    },
    ruleTriggers: [],
    knownIssues: [
      {
        description: "build 阶段 tests/ 目录可能出现 TS2307: Cannot find module 'japa' 或 'sinon'",
        pattern: 'TS2307',
        advice: '这是测试框架类型声明的已知问题，可以忽略',
      },
    ],
  };

  return {
    getProjectKnowledge: () => null,
    KNOWLEDGE_DEFAULTS,
    loadKnowledge: () => null,
    reloadKnowledge: () => null,
    resetKnowledgeCache: vi.fn(),
  };
});

// Must import AFTER mocks
import type { PromptContext, ConflictResolveContext, ReviewRoundForPrompt, E2ePromptPorts } from '../../../src/prompts/templates.js';

describe('prompt templates', () => {
  let templates: typeof import('../../../src/prompts/templates.js');

  beforeEach(async () => {
    // Dynamic import to pick up mocks
    templates = await import('../../../src/prompts/templates.js');
  });

  const baseCtx: PromptContext = {
    issueTitle: '实现用户登录功能',
    issueDescription: '需要添加用户名密码登录，支持 OAuth2.0 第三方登录',
    issueIid: 42,
    supplementText: '## 补充信息\n\n### 补充需求说明\n需要支持微信登录',
  };

  const ctxNoSupplement: PromptContext = {
    issueTitle: '修复首页加载缓慢问题',
    issueDescription: '首页加载超过 5 秒，需要优化',
    issueIid: 99,
  };

  it('planModeVerifyPrompt', () => {
    expect(templates.planModeVerifyPrompt(baseCtx)).toMatchSnapshot();
  });

  it('planPrompt with supplement', () => {
    expect(templates.planPrompt(baseCtx)).toMatchSnapshot();
  });

  it('planPrompt without supplement', () => {
    expect(templates.planPrompt(ctxNoSupplement)).toMatchSnapshot();
  });

  it('buildPrompt', () => {
    expect(templates.buildPrompt(baseCtx)).toMatchSnapshot();
  });

  it('rePlanPrompt with review history', () => {
    const history: ReviewRoundForPrompt[] = [
      { round: 1, feedback: '数据库设计需要增加索引', timestamp: '2024-06-01T10:00:00Z' },
      { round: 2, feedback: 'API 接口缺少权限校验', timestamp: '2024-06-01T11:00:00Z' },
    ];
    expect(templates.rePlanPrompt(baseCtx, history)).toMatchSnapshot();
  });

  it('rePlanPrompt with latest planSnapshot （只读计划）', () => {
    // 锁定 cursor-agent / codex-sdk (PTY profile 触发) 路径下:
    // 仅注入"最新一轮"的 planSnapshot,前几轮的 snapshot 不进 prompt,
    // 避免给 AI 一堆已被迭代的旧方案造成干扰。
    const history: ReviewRoundForPrompt[] = [
      {
        round: 1, feedback: '第一轮:加索引', timestamp: '2024-06-01T10:00:00Z',
        planSnapshot: '# V1 方案\n\n旧版,不应进 prompt',
      },
      {
        round: 2, feedback: '第二轮:加权限校验', timestamp: '2024-06-01T11:00:00Z',
        planSnapshot: '# V2 方案\n\n这是被驳回的最新版,应进 prompt',
      },
    ];
    expect(templates.rePlanPrompt(baseCtx, history)).toMatchSnapshot();
  });

  it('rePlanPrompt with no planSnapshot （无计划快照）', () => {
    // 历史数据可能缺 planSnapshot 字段。此时不应注入 rejected-plan 块,
    // readInstruction 应退回到"参考审核反馈历史"提示。
    const history: ReviewRoundForPrompt[] = [
      { round: 1, feedback: '需要补错误处理', timestamp: '2024-06-01T10:00:00Z' },
    ];
    expect(templates.rePlanPrompt(baseCtx, history)).toMatchSnapshot();
  });

  it('rePlanPrompt 保留超长计划的完整快照', () => {
    const huge = '占位文本'.repeat(3000);
    const history: ReviewRoundForPrompt[] = [
      { round: 1, feedback: '需要重新设计', timestamp: '2024-06-01T10:00:00Z', planSnapshot: huge },
    ];
    const prompt = templates.rePlanPrompt(baseCtx, history);
    expect(prompt).toContain('<rejected-plan>');
    expect(prompt).not.toContain('已截断至');
    const match = prompt.match(/<rejected-plan>\n([\s\S]*?)\n<\/rejected-plan>/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(huge);
  });

  it('e2eVerifyPromptSuffix without ports', () => {
    expect(templates.e2eVerifyPromptSuffix(baseCtx)).toMatchSnapshot();
  });

  it('e2eVerifyPromptSuffix with ports', () => {
    const ports: E2ePromptPorts = {
      backendPort: 4001,
      frontendPort: 9001,
      host: '127.0.0.1',
    };
    expect(templates.e2eVerifyPromptSuffix(baseCtx, ports)).toMatchSnapshot();
  });

  it('conflictResolvePrompt', () => {
    const ctx: ConflictResolveContext = {
      issueIid: 42,
      branchName: 'feat/issue-42',
      baseBranch: 'master',
      conflictFiles: ['src/index.ts', 'src/config.ts', 'package.json'],
    };
    expect(templates.conflictResolvePrompt(ctx)).toMatchSnapshot();
  });

  it('issueProgressComment - in progress', () => {
    expect(templates.issueProgressComment('analysis', 'in_progress')).toMatchSnapshot();
  });

  it('issueProgressComment - completed', () => {
    expect(templates.issueProgressComment('verify', 'completed')).toMatchSnapshot();
  });

  it('issueProgressComment - failed with detail', () => {
    expect(templates.issueProgressComment('implement', 'failed', 'AI 超时: 30分钟限制已到')).toMatchSnapshot();
  });

  it('demandToPromptContext with full supplement', () => {
    const demand = {
      demandId: 'gh-42',
      sourceRef: { source: 'github-issue' as const, externalId: '100', displayId: '42' },
      title: '添加用户登录',
      description: '实现用户登录功能',
      supplement: {
        requirements: '支持微信和 QQ 登录',
        acceptanceCriteria: '通过率 100%',
        scope: 'auth 模块',
        constraints: '不能修改数据库 schema',
        references: 'https://wiki.example.com/login-spec',
        freeText: '注意兼容老版本',
      },
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(templates.demandToPromptContext(demand)).toMatchSnapshot();
  });

  it('demandToPromptContext without supplement', () => {
    const demand = {
      demandId: 'gh-99',
      sourceRef: { source: 'github-issue' as const, externalId: '200', displayId: '99' },
      title: '修复 Bug',
      description: '页面崩溃',
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(templates.demandToPromptContext(demand)).toMatchSnapshot();
  });

  it('getKnowledgeForPrompt returns deterministic map', () => {
    expect(templates.getKnowledgeForPrompt()).toMatchSnapshot();
  });
});
