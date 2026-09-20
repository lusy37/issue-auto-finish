import { describe, it, expect } from 'vitest';
import { githubIssueToDemandSpec } from '../../../src/demand/adapters/GitHubAdapter.js';
import type { GitHubIssue } from '../../../src/clients/GitHubClient.js';

function createMockIssue(overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    id: 1001,
    number: 42,
    title: '实现用户注册功能',
    description: '需要添加注册表单和后端 API',
    state: 'open',
    labels: ['auto-finish', 'feature'],
    created_at: '2026-03-01T08:00:00.000Z',
    updated_at: '2026-03-01T10:00:00.000Z',
    author: { username: 'testuser', name: 'Test User' },
    ...overrides,
  };
}

describe('GitHubAdapter snapshots', () => {
  it('converts basic issue without supplement', () => {
    const issue = createMockIssue();
    const result = githubIssueToDemandSpec(issue);
    expect(result).toMatchSnapshot();
  });

  it('converts issue with null supplement', () => {
    const issue = createMockIssue();
    const result = githubIssueToDemandSpec(issue, null);
    expect(result).toMatchSnapshot();
  });

  it('converts issue with full supplement', () => {
    const issue = createMockIssue();
    const result = githubIssueToDemandSpec(issue, { updatedAt: "2026-09-20T00:00:00Z",
      requirements: '需要支持邮箱和手机号注册',
      acceptanceCriteria: '注册后自动登录',
      scope: '仅涉及 /auth 路由',
      constraints: '不使用第三方认证服务',
      references: 'RFC 7519 JWT 规范',
      freeText: '注意安全性',
    });
    expect(result).toMatchSnapshot();
  });

  it('converts issue with partial supplement (empty strings filtered)', () => {
    const issue = createMockIssue();
    const result = githubIssueToDemandSpec(issue, { updatedAt: "2026-09-20T00:00:00Z",
      requirements: '基本需求',
      acceptanceCriteria: '',
      scope: '  ',
      constraints: '', references: '', freeText: '',
    });
    expect(result).toMatchSnapshot();
  });

  it('handles issue with empty description', () => {
    const issue = createMockIssue({ description: '' });
    const result = githubIssueToDemandSpec(issue);
    expect(result).toMatchSnapshot();
  });
});
