import { describe, it, expect } from 'vitest';
import type { DemandSpec, DemandSource, SourceRef, DemandSupplement } from '../../src/demand/DemandSpec.js';
import { githubIssueToDemandSpec } from '../../src/demand/adapters/GitHubAdapter.js';
import { demandToPromptContext } from '../../src/prompts/templates.js';
import type { GitHubIssue } from '../../src/clients/GitHubClient.js';
import type { SupplementInfo } from '../../src/supplement/SupplementStore.js';

describe('DemandSpec', () => {
  describe('type constraints', () => {
    it('DemandSpec is a valid value object', () => {
      const spec: DemandSpec = {
        demandId: 'gh-42',
        sourceRef: {
          source: 'github-issue',
          externalId: '42',
          displayId: '42',
          url: 'https://example.com/issues/42',
        },
        title: 'Test Issue',
        description: 'Test description',
        createdAt: '2024-01-01T00:00:00Z',
      };
      expect(spec.demandId).toBe('gh-42');
      expect(spec.sourceRef.source).toBe('github-issue');
      expect(spec.sourceRef.externalId).toBe('42');
      expect(spec.sourceRef.displayId).toBe('42');
      expect(spec.title).toBe('Test Issue');
      expect(spec.description).toBe('Test description');
    });

    it('supports all DemandSource types', () => {
      const sources: DemandSource[] = ['github-issue', 'user-input'];
      expect(sources).toHaveLength(2);
    });

    it('DemandSupplement fields are all optional', () => {
      const empty: DemandSupplement = {};
      expect(empty).toEqual({});

      const full: DemandSupplement = {
        requirements: 'req',
        acceptanceCriteria: 'ac',
        scope: 'scope',
        constraints: 'constraints',
        references: 'refs',
        freeText: 'free',
      };
    });
  });
});

describe('GitHubAdapter', () => {
  const baseIssue: GitHubIssue = {
    id: 100,
    number: 42,
    title: 'Test Issue',
    description: 'Test description',
    state: 'open',
    labels: ['auto-finish'],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    author: { username: 'user', name: 'User' },
  };

  it('converts basic GitHubIssue to DemandSpec', () => {
    const spec = githubIssueToDemandSpec(baseIssue);

    expect(spec.demandId).toBe('gh-42');
    expect(spec.sourceRef).toEqual({
      source: 'github-issue',
      externalId: '42',
      displayId: '42',
    });
    expect(spec.title).toBe('Test Issue');
    expect(spec.description).toBe('Test description');
    expect(spec.supplement).toBeUndefined();
    expect(spec.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('handles null supplement', () => {
    const spec = githubIssueToDemandSpec(baseIssue, null);
    expect(spec.supplement).toBeUndefined();
  });

  it('converts supplement info', () => {
    const supplement: SupplementInfo = {
      requirements: 'Need feature X',
      acceptanceCriteria: 'Must pass tests',
      scope: 'backend only',
      constraints: 'No breaking changes',
      references: 'https://doc.example.com',
      freeText: 'Extra notes',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const spec = githubIssueToDemandSpec(baseIssue, supplement);

    expect(spec.supplement).toEqual({
      requirements: 'Need feature X',
      acceptanceCriteria: 'Must pass tests',
      scope: 'backend only',
      constraints: 'No breaking changes',
      references: 'https://doc.example.com',
      freeText: 'Extra notes',
    });
  });

  it('filters empty supplement fields', () => {
    const supplement: SupplementInfo = {
      requirements: '',
      acceptanceCriteria: '  ',
      scope: 'backend only',
      constraints: '',
      references: '',
      freeText: '',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const spec = githubIssueToDemandSpec(baseIssue, supplement);
    expect(spec.supplement).toEqual({ scope: 'backend only' });
  });

  it('returns undefined supplement when all fields are empty', () => {
    const supplement: SupplementInfo = {
      requirements: '',
      acceptanceCriteria: '',
      scope: '',
      constraints: '',
      references: '',
      freeText: '',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const spec = githubIssueToDemandSpec(baseIssue, supplement);
    expect(spec.supplement).toBeUndefined();
  });

  it('handles issue with empty description', () => {
    const issue = { ...baseIssue, description: '' };
    const spec = githubIssueToDemandSpec(issue);
    expect(spec.description).toBe('');
  });
});

describe('demandToPromptContext', () => {
  it('converts DemandSpec to prompt context', () => {
    const demand: DemandSpec = {
      demandId: 'gh-42',
      sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
      title: 'Test Issue',
      description: 'Test description',
      createdAt: '2024-01-01T00:00:00Z',
    };

    const pc = demandToPromptContext(demand);
    expect(pc.title).toBe('Test Issue');
    expect(pc.description).toBe('Test description');
    expect(pc.displayId).toBe('42');
    expect(pc.supplementText).toBe('');
  });

  it('formats supplement text sections', () => {
    const demand: DemandSpec = {
      demandId: 'gh-42',
      sourceRef: { source: 'github-issue', externalId: '42', displayId: '42' },
      title: 'Test',
      description: 'Desc',
      supplement: {
        requirements: '需要功能X',
        acceptanceCriteria: '测试通过',
      },
      createdAt: '2024-01-01T00:00:00Z',
    };

    const pc = demandToPromptContext(demand);
    expect(pc.supplementText).toContain('## 补充信息');
    expect(pc.supplementText).toContain('### 补充需求说明');
    expect(pc.supplementText).toContain('需要功能X');
    expect(pc.supplementText).toContain('### 验收标准');
    expect(pc.supplementText).toContain('测试通过');
  });

  it('falls back to demandId when displayId is missing', () => {
    const demand: DemandSpec = {
      demandId: 'manual-999',
      sourceRef: { source: 'user-input', externalId: '999' },
      title: '手动需求',
      description: '来自用户输入',
      createdAt: '2024-01-01T00:00:00Z',
    };

    const pc = demandToPromptContext(demand);
    expect(pc.displayId).toBe('manual-999');
  });
});
