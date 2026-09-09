import { it, expect } from 'vitest';
import { generatePRTitle, generatePRDescription } from '../../src/utils/PullRequestHelper.js';
it('PR 标题和正文关联当前 Issue', () => {
  expect(generatePRTitle(42, '修复登录')).toBe('feat(#42): 修复登录');
  const body=generatePRDescription({issueIid:42,issueTitle:'修复登录',issueDescription:'增加校验',branchName:'feat/issue-42'});
  expect(body).toContain('#42');expect(body).toContain('增加校验');expect(body).toContain('feat/issue-42');
});
it('缺少 Issue 描述时显示占位说明', () => {
  expect(generatePRDescription({issueIid:1,issueTitle:'测试',issueDescription:'',branchName:'feat/issue-1'})).toContain('（无描述）');
});
