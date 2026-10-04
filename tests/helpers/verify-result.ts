import { VERIFY_AGENT_SCHEMA_VERSION } from '../../src/verify/VerifyResultCodec.js';

export function verifyAgentOutput(options?: {
  lint?: 'passed' | 'failed';
  build?: 'passed' | 'failed';
  test?: 'passed' | 'failed';
  reportMarkdown?: string;
}): string {
  const lint = options?.lint ?? 'passed';
  const build = options?.build ?? 'passed';
  const test = options?.test ?? 'passed';
  const check = (status: 'passed' | 'failed', command: string, summary: string) => ({
    status,
    command,
    exitCode: status === 'passed' ? 0 : 1,
    summary,
    diagnostics: status === 'passed' ? [] : [summary],
  });
  const reportMarkdown = options?.reportMarkdown ?? [
    '# 验证报告',
    '',
    `- Lint：${lint === 'passed' ? '通过' : '失败'}`,
    `- Build：${build === 'passed' ? '通过' : '失败'}`,
    `- Test：${test === 'passed' ? '通过' : '失败'}`,
    '',
    '## 总结',
    lint === 'passed' && build === 'passed' && test === 'passed' ? '全部检查通过。' : '存在未通过的检查。',
  ].join('\n');
  return JSON.stringify({
    schemaVersion: VERIFY_AGENT_SCHEMA_VERSION,
    phase: 'verify',
    checks: {
      lint: check(lint, 'npm run lint', lint === 'passed' ? 'Lint 通过' : 'Lint 失败'),
      build: check(build, 'npm run build', build === 'passed' ? 'Build 通过' : 'Build 失败'),
      test: check(test, 'npm test', test === 'passed' ? 'Test 通过' : 'Test 失败'),
    },
    summary: lint === 'passed' && build === 'passed' && test === 'passed' ? '全部检查通过' : '验证失败',
    reportMarkdown,
  });
}
