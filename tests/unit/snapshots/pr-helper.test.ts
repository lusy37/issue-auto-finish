import { describe,it,expect } from 'vitest';
import { generatePRDescription } from '../../../src/utils/PullRequestHelper.js';
describe('PullRequestHelper snapshots',()=>{
  describe('generatePRDescription', () => {
    it('basic description without plan dir', () => {
      const result = generatePRDescription({
        issueIid: 42,
        issueTitle: '实现用户认证功能',
        issueDescription: '需要添加 JWT 认证到 API 端点',
        branchName: 'feat/issue-42',
      });
      expect(result).toMatchSnapshot();
    });

    it('description with empty issue description', () => {
      const result = generatePRDescription({
        issueIid: 100,
        issueTitle: 'Quick Fix',
        issueDescription: '',
        branchName: 'feat/issue-100',
      });
      expect(result).toMatchSnapshot();
    });
  });
});
