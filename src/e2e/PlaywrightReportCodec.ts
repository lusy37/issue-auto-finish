import { z } from 'zod';

const testStatusSchema = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const errorSchema = z.object({ message: z.string().optional() });
const attachmentSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  body: z.string().optional(),
  contentType: z.string(),
});
const resultSchema = z.object({
  status: testStatusSchema.optional(),
  error: errorSchema.optional(),
  errors: z.array(errorSchema).optional(),
  attachments: z.array(attachmentSchema).default([]),
});
const testSchema = z.object({
  expectedStatus: testStatusSchema,
  status: z.enum(['expected', 'unexpected', 'flaky', 'skipped']),
  projectName: z.string().optional(),
  results: z.array(resultSchema),
});
const specSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tests: z.array(testSchema),
});

export interface PlaywrightReportSuite {
  specs: z.infer<typeof specSchema>[];
  suites?: PlaywrightReportSuite[];
}

const suiteSchema: z.ZodType<PlaywrightReportSuite> = z.lazy(() => z.object({
  specs: z.array(specSchema),
  suites: z.array(suiteSchema).optional(),
}));
const reportSchema = z.object({
  suites: z.array(suiteSchema).default([]),
  stats: z.object({
    expected: z.number().int().nonnegative(),
    unexpected: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  errors: z.array(errorSchema),
});

export type PlaywrightReport = z.infer<typeof reportSchema>;
export type PlaywrightTestResult = z.infer<typeof resultSchema>;
export type PlaywrightSpec = z.infer<typeof specSchema>;

export function parsePlaywrightReport(report: unknown): PlaywrightReport {
  return reportSchema.parse(report);
}

export function visitPlaywrightResults(
  report: PlaywrightReport,
  visit: (result: PlaywrightTestResult, spec: PlaywrightSpec, projectName: string) => void,
): void {
  const visitSuite = (suite: PlaywrightReportSuite): void => {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        for (const result of test.results) visit(result, spec, test.projectName ?? 'default');
      }
    }
    suite.suites?.forEach(visitSuite);
  };
  report.suites.forEach(visitSuite);
}

export function playwrightReportErrors(report: PlaywrightReport): string[] {
  const messages = report.errors.flatMap((error) => error.message ?? []);
  visitPlaywrightResults(report, (result) => {
    if (result.error?.message) messages.push(result.error.message);
    for (const error of result.errors ?? []) {
      if (error.message) messages.push(error.message);
    }
  });
  return [...new Set(messages)];
}

/** 按官方 JSON 报告结构建立索引，支持报告 ID 和代码中的测试标题。 */
export function passedPlaywrightTests(report: unknown): ReadonlySet<string> {
  const parsed = parsePlaywrightReport(report);
  const outcomes = new Map<string, boolean>();
  const visit = (suite: PlaywrightReportSuite): void => {
    for (const spec of suite.specs) {
      const passed = spec.tests.length > 0 && spec.tests.every((test) => (
        test.expectedStatus === 'passed' && test.status === 'expected'
        && test.results.length > 0
        && test.results.every((result) => result.status === 'passed')
      ));
      for (const id of new Set([spec.id, spec.title])) {
        outcomes.set(id, (outcomes.get(id) ?? true) && passed);
      }
    }
    suite.suites?.forEach(visit);
  };
  parsed.suites.forEach(visit);
  return new Set([...outcomes].filter(([, passed]) => passed).map(([id]) => id));
}
