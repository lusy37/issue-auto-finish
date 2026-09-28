/** 检查结果必须明确报告；计划任务的完成度由 DAG 合并凭证判定。 */
export interface VerifyReportResult {
  valid: boolean;
  passed: boolean;
  lintPassed: boolean;
  buildPassed: boolean;
  testPassed: boolean;
  failureReasons: string[];
  rawReport: string;
}

const SUMMARY_FAIL_RE =
  /\*{0,2}(?:总结|Summary)\*{0,2}\s*[:：].*(?:验证失败|verification\s+failed|failed|失败)/i;

function checkResult(report: string, name: string): boolean | undefined {
  const results = [
    ...report.matchAll(
      new RegExp(
        name +
          '\\s*(?:结果|Result)\\*{0,2}\\s*[:：]\\s*(通过|失败|passed|failed|pass|fail|未通过)(?![a-z])',
        'gi',
      ),
    ),
  ];
  if (!results.length) return undefined;
  return results.every((match) => /^(通过|passed|pass)$/i.test(match[1]));
}

export class VerifyReportParser {
  parse(rawReport: string): VerifyReportResult {
    const lint = checkResult(rawReport, 'Lint');
    const build = checkResult(rawReport, 'Build');
    const test = checkResult(rawReport, 'Test');
    const valid = [lint, build, test].every((result) => result !== undefined);
    const failureReasons: string[] = [];
    if (!valid) failureReasons.push('验证报告缺少本次 Lint、Build 或 Test 的明确结果');
    if (lint === false) failureReasons.push('Lint 检查失败');
    if (build === false) failureReasons.push('Build 编译失败');
    if (test === false) failureReasons.push('测试未通过');
    if (!failureReasons.length && SUMMARY_FAIL_RE.test(rawReport))
      failureReasons.push('验证报告总结判定为失败');
    return {
      valid,
      passed: !failureReasons.length,
      lintPassed: lint === true,
      buildPassed: build === true,
      testPassed: test === true,
      failureReasons,
      rawReport,
    };
  }
}
