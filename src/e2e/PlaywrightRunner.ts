import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import { randomUUID } from 'node:crypto';
import type { MachineUatResult, ScreenshotEvidence } from '../shared/workbench.js';
export type { UatResult } from '../shared/workbench.js';
import { resolveDataDir, ensureDir } from '../paths.js';
import { collectScreenshotEvidence } from './VisualEvidence.js';
import { runPlaywrightProcess } from './PlaywrightProcess.js';
import {
  parsePlaywrightReport,
  playwrightReportErrors,
  type PlaywrightReport,
} from './PlaywrightReportCodec.js';

const active = new Map<number, AbortController>();

export function cancelUat(issueIid?: number): void {
  for (const [number, controller] of active) {
    if (issueIid === undefined || issueIid === number) controller.abort();
  }
}

export interface ValidatedUatReport {
  report: PlaywrightReport;
  passed: boolean;
  reportValid: boolean;
  reportErrors: string[];
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  failureKind?: MachineUatResult['failureKind'];
}

/** 只有实际读取的本次报告才能生成机器结果。 */
export function validateUatReport(report: unknown, code: number | null): ValidatedUatReport {
  const value = parsePlaywrightReport(report);
  const reportErrors = playwrightReportErrors(value);
  const passedTests = value.stats.expected;
  const failedTests = value.stats.unexpected + value.stats.flaky;
  const skippedTests = value.stats.skipped;
  const passed = code === 0 && passedTests > 0 && failedTests === 0 && reportErrors.length === 0;
  return {
    report: value,
    passed,
    reportValid: true,
    reportErrors,
    passedTests,
    failedTests,
    skippedTests,
    failureKind: passed
      ? undefined
      : failedTests > 0 && value.errors.length === 0 ? 'assertion' : 'environment',
  };
}

type MachineResultWithRun = MachineUatResult & {
  runId: string;
  issueIid: number;
  reportAvailable: boolean;
};

function saveUatArtifacts(
  outputDir: string,
  commandLog: string,
  machine: MachineResultWithRun,
): void {
  fs.writeFileSync(path.join(outputDir, 'command.log'), commandLog);
  writeJsonAtomicSync(path.join(outputDir, 'machine.json'), machine);
  writeJsonAtomicSync(path.join(outputDir, 'screenshots.json'), machine.screenshots);
}

export async function executeUat(options: {
  issueIid: number;
  runId?: string;
  dataDir?: string;
  outputDir?: string;
  signal?: AbortSignal;
  onTemporaryFile?: (file: string, present: boolean) => void;
  workDir: string;
  configFile: string;
  browserChannel?: string;
  baseUrl: string;
  timeoutMs: number;
  onOutput?: (text: string) => void;
}): Promise<MachineResultWithRun> {
  if (active.has(options.issueIid)) throw new Error('该任务正在执行浏览器验收');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  active.set(options.issueIid, controller);

  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const dataDir = options.dataDir ?? resolveDataDir();
  const outputDir = ensureDir(options.outputDir ?? path.join(dataDir, 'uat', runId));
  let report: PlaywrightReport | undefined;
  let commandCode: number | null = null;
  let reportAvailable = false;
  let commandLog = '';
  let error: string | undefined;
  let failureKind: MachineUatResult['failureKind'];
  let reportResult: ValidatedUatReport | undefined;

  try {
    const processResult = await runPlaywrightProcess({
      runId,
      issueIid: options.issueIid,
      dataDir,
      outputDir,
      workDir: options.workDir,
      configFile: options.configFile,
      browserChannel: options.browserChannel,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      onTemporaryFile: options.onTemporaryFile,
      onOutput: options.onOutput,
    });
    commandCode = processResult.code;
    reportAvailable = processResult.reportAvailable;
    commandLog = processResult.commandLog;
    if (processResult.error) throw new Error(processResult.error);
    reportResult = validateUatReport(processResult.report, commandCode);
    report = reportResult.report;
    if (!reportResult.passed) {
      error = reportResult.reportErrors.join('\n').slice(0, 2000)
        || processResult.stderr.slice(-1000)
        || '没有实际通过的测试，请查看本次报告';
      failureKind = reportResult.failureKind;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    failureKind = 'environment';
  } finally {
    options.signal?.removeEventListener('abort', abort);
    active.delete(options.issueIid);
  }

  const collection = report
    ? collectScreenshotEvidence(report, outputDir)
    : { evidence: [] as ScreenshotEvidence[], errors: [] };
  if (collection.errors.length && !error) {
    error = collection.errors.join('\n').slice(0, 2000);
  }
  const machineCancelled = controller.signal.aborted || options.signal?.aborted === true;
  const machineFinishedAt = new Date().toISOString();
  const machine: MachineResultWithRun = {
    runId,
    issueIid: options.issueIid,
    startedAt,
    machineFinishedAt,
    passed: (reportResult?.passed ?? false) && !machineCancelled,
    playwrightExitCode: commandCode,
    machineCancelled,
    reportValid: reportResult?.reportValid ?? false,
    reportErrors: reportResult?.reportErrors ?? [],
    passedTests: reportResult?.passedTests ?? 0,
    failedTests: reportResult?.failedTests ?? 0,
    skippedTests: reportResult?.skippedTests ?? 0,
    screenshots: collection.evidence,
    failureKind,
    error,
    reportAvailable,
  };
  saveUatArtifacts(outputDir, commandLog, machine);
  return machine;
}
