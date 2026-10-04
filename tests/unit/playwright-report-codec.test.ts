import { describe, expect, it } from 'vitest';
import { passedPlaywrightTests } from '../../src/e2e/PlaywrightReportCodec.js';

function test(overrides = {}) {
  return {
    expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }],
    ...overrides,
  };
}
function spec(id = 'test-id', title = '登录成功', tests = [test()]) {
  return { id, title, tests };
}
function report(specs = [spec()]) {
  return {
    suites: [{ specs: [], suites: [{ specs }] }],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
  };
}

describe('Playwright 通过测试索引', () => {
  it('只沿 suites 和 specs 读取测试，以报告 ID 和测试标题查询', () => {
    const passed = passedPlaywrightTests({
      ...report(),
      errors: [{ id: '伪造测试', status: 'passed' }],
    });
    expect([...passed]).toEqual(['test-id', '登录成功']);
    expect(passed.has('伪造测试')).toBe(false);
  });

  it.each([
    ['断言失败', test({ status: 'unexpected', results: [{ status: 'failed' }] })],
    ['先失败再通过', test({ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] })],
    ['跳过', test({ status: 'skipped', results: [{ status: 'skipped' }] })],
    ['超时', test({ status: 'unexpected', results: [{ status: 'timedOut' }] })],
    ['中断', test({ status: 'unexpected', results: [{ status: 'interrupted' }] })],
    ['预期失败', test({ expectedStatus: 'failed', results: [{ status: 'failed' }] })],
    ['没有实际执行', test({ results: [] })],
  ])('%s 不能证明行为覆盖', (_name, result) => {
    expect(passedPlaywrightTests(report([spec('test-id', '登录成功', [result])])).size).toBe(0);
  });

  it('同一测试必须在所有项目和重复执行中通过', () => {
    const specs = [
      spec('test-id', '登录成功', [test(), test({ status: 'unexpected' })]),
      spec('other-id', '其他测试'),
    ];
    const passed = passedPlaywrightTests(report(specs));
    expect(passed.has('test-id')).toBe(false);
    expect(passed.has('other-id')).toBe(true);
  });

  it('重名测试有失败时，不以同名通过项掩盖失败', () => {
    const passed = passedPlaywrightTests(report([
      spec('first-id', '登录成功'),
      spec('second-id', '登录成功', [test({ status: 'unexpected' })]),
    ]));
    expect(passed.has('first-id')).toBe(true);
    expect(passed.has('登录成功')).toBe(false);
  });

  it('格式不完整的报告在解析边界失败', () => {
    expect(() => passedPlaywrightTests({ suites: [{ specs: [{ title: '缺少 ID' }] }] })).toThrow();
  });
});
