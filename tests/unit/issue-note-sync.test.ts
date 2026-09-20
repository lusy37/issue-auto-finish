import { afterEach,describe,expect,it } from 'vitest';
import {
buildNoteSyncComment,
getNoteSyncEnabled,
isNoteSyncEnabledForIssue,
setNoteSyncOverride,
truncateToSummary,
} from '../../src/notesync/NoteSyncSettings.js';
import {
createMockIssueTracker,
createTestConfig,
} from '../helpers/mock-factories.js';

describe('NoteSyncSettings', () => {
  afterEach(() => {
    setNoteSyncOverride(undefined);
  });

  describe('getNoteSyncEnabled', () => {
    it('should return config value when no override', () => {
      const cfg = createTestConfig({ issueNoteSync: { enabled: true, webBaseUrl: 'http://localhost:3000' } });
      expect(getNoteSyncEnabled(cfg)).toBe(true);

      const cfg2 = createTestConfig({ issueNoteSync: { enabled: false, webBaseUrl: 'http://localhost:3000' } });
      expect(getNoteSyncEnabled(cfg2)).toBe(false);
    });

    it('should return override when set', () => {
      const cfg = createTestConfig({ issueNoteSync: { enabled: true, webBaseUrl: 'http://localhost:3000' } });
      setNoteSyncOverride(false);
      expect(getNoteSyncEnabled(cfg)).toBe(false);

      setNoteSyncOverride(true);
      expect(getNoteSyncEnabled(cfg)).toBe(true);
    });

    it('should revert to config after override cleared', () => {
      const cfg = createTestConfig({ issueNoteSync: { enabled: false, webBaseUrl: 'http://localhost:3000' } });
      setNoteSyncOverride(true);
      expect(getNoteSyncEnabled(cfg)).toBe(true);

      setNoteSyncOverride(undefined);
      expect(getNoteSyncEnabled(cfg)).toBe(false);
    });
  });

  describe('isNoteSyncEnabledForIssue', () => {
    it('should follow system setting when issue has no override', () => {
      const tracker = createMockIssueTracker();
      tracker.get.mockReturnValue({
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        lifecycle: { kind: 'running', phase: 'build' },
        issueNoteSyncEnabled: undefined,
      });
      const cfg = createTestConfig({ issueNoteSync: { enabled: true, webBaseUrl: '' } });
      expect(isNoteSyncEnabledForIssue(42, tracker as any, cfg)).toBe(true);
    });

    it('should use issue-level override when set to true', () => {
      const tracker = createMockIssueTracker();
      tracker.get.mockReturnValue({
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        lifecycle: { kind: 'running', phase: 'build' },
        issueNoteSyncEnabled: true,
      });
      const cfg = createTestConfig({ issueNoteSync: { enabled: false, webBaseUrl: '' } });
      expect(isNoteSyncEnabledForIssue(42, tracker as any, cfg)).toBe(true);
    });

    it('should use issue-level override when set to false', () => {
      const tracker = createMockIssueTracker();
      tracker.get.mockReturnValue({
        demandSpec: {
          demandId: 'gh-42',
          sourceRef: { source: 'github-issue', externalId: '100', displayId: '42' },
          title: 'Test',
          description: '',
          createdAt: '2024-01-01T00:00:00Z',
        },
        lifecycle: { kind: 'running', phase: 'build' },
        issueNoteSyncEnabled: false,
      });
      const cfg = createTestConfig({ issueNoteSync: { enabled: true, webBaseUrl: '' } });
      expect(isNoteSyncEnabledForIssue(42, tracker as any, cfg)).toBe(false);
    });

    it('should fall back to system when issue not found', () => {
      const tracker = createMockIssueTracker();
      tracker.get.mockReturnValue(undefined);
      const cfg = createTestConfig({ issueNoteSync: { enabled: true, webBaseUrl: '' } });
      expect(isNoteSyncEnabledForIssue(42, tracker as any, cfg)).toBe(true);
    });
  });

  describe('truncateToSummary', () => {
    it('should return short content as-is', () => {
      expect(truncateToSummary('hello world')).toBe('hello world');
    });

    it('should truncate long content at paragraph boundary', () => {
      const paragraph1 = 'A'.repeat(200);
      const paragraph2 = 'B'.repeat(200);
      const paragraph3 = 'C'.repeat(200);
      const content = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;
      const result = truncateToSummary(content);
      expect(result.length).toBeLessThan(content.length);
      expect(result).toContain('...');
    });

    it('should not exceed ~500 chars plus ellipsis', () => {
      const content = 'X'.repeat(1000);
      const result = truncateToSummary(content);
      expect(result.length).toBeLessThanOrEqual(510);
    });
  });

  describe('buildNoteSyncComment', () => {
    it('should build a comment with summary and links', () => {
      const comment = buildNoteSyncComment(
        'plan',
        '规划',
        'http://host/doc/42/01-plan.md',
        'http://host/?issue=42',
        '这是摘要内容',
      );
      expect(comment).toContain('**规划阶段完成**');
      expect(comment).toContain('这是摘要内容');
      expect(comment).toContain('[查看完整规划文档](http://host/doc/42/01-plan.md)');
      expect(comment).toContain('[在管理面板中查看详情](http://host/?issue=42)');
      expect(comment).toContain('📋');
    });

    it('should use correct emoji for each phase', () => {
      expect(buildNoteSyncComment('uat', '验收', '', '', '')).toContain('🧪');
      expect(buildNoteSyncComment('verify', '验证', '', '', '')).toContain('✅');
      expect(buildNoteSyncComment('plan', '规划', '', '', '')).toContain('📋');
    });
  });
});
