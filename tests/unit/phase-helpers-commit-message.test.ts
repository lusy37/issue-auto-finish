import { it, expect } from 'vitest';
import { buildAutoCommitMessage } from '../../src/orchestrator/steps/PhaseHelpers.js';
it('提交信息关联当前 Issue', () => {
  expect(buildAutoCommitMessage('build', 42)).toBe('chore(auto): build phase completed for issue #42');
});
