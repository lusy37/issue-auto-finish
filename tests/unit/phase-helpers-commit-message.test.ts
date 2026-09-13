import { it, expect } from 'vitest';
import * as helpers from '../../src/orchestrator/steps/PhaseHelpers.js';
it('阶段辅助层不再暴露提交运行文件或提前创建 PR 的入口', () => {
  expect(helpers).not.toHaveProperty('commitPlanFiles');
  expect(helpers).not.toHaveProperty('ensurePrCreated');
});
