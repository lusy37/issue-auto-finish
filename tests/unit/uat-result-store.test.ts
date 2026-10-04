import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UAT_FORMAT } from '../../src/shared/runtime/formats.js';
import type { UatResult } from '../../src/shared/workbench.js';
import { UatResultStore } from '../../src/e2e/UatResultStore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('UAT 结果摘要', () => {
  it('读取字段顺序不同但内容相同的终态摘要时仍通过 Zod 规范化哈希校验', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iaf-uat-result-'));
    roots.push(root);
    const store = new UatResultStore(root);
    const now = new Date().toISOString();
    const result: UatResult = {
      format: UAT_FORMAT, status: 'completed', runId: 'run-001', issueIid: 1,
      machinePassed: true, passed: true, passedTests: 1, failedTests: 0, skippedTests: 0,
      evidence: [], reportAvailable: false, startedAt: now, machineFinishedAt: now,
      finishedAt: now,
      visualReview: {
        status: 'not-run', summary: '视觉复核未启用', issues: [], selectedScreenshots: [],
        checkedScreenshots: [], unreviewedScreenshots: [], coverageGaps: [], reasonCode: 'disabled',
      },
      policy: { visualReviewEnabled: false, maxImages: 12, timeoutMs: 180000 },
      execution: {
        candidateCommit: 'commit-001', planRevision: 1, planDigest: 'digest-001',
        buildGeneration: 0, dispatchId: 'dispatch-001', phaseAttemptNo: 1,
      },
    };
    const reorderedResult = Object.fromEntries(Object.entries(result).reverse()) as unknown as UatResult;
    expect(UatResultStore.digest(reorderedResult)).toBe(UatResultStore.digest(result));

    result.summaryDigest = UatResultStore.digest(result);
    store.writeSummary(result);

    expect(store.readSummary(result.runId)).toMatchObject({
      status: 'completed', passed: true, summaryDigest: result.summaryDigest,
    });

    const raw = JSON.parse(fs.readFileSync(path.join(store.runDir(result.runId), 'summary.json'), 'utf8')) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    fs.writeFileSync(path.join(store.runDir(result.runId), 'summary.json'), JSON.stringify(reordered));

    expect(store.readSummary(result.runId).summaryDigest).toBe(result.summaryDigest);

    const expected = {
      candidateCommit: 'commit-001', planRevision: 1, planDigest: 'digest-001', buildGeneration: 0,
    };
    expect(store.createReceipt(result.runId, expected, 'report.md')).toMatchObject({
      commit: 'commit-001', completedAt: now, runId: result.runId,
      uatEvidence: { summaryDigest: result.summaryDigest },
    });
    for (const changed of [
      { candidateCommit: 'old-commit' }, { planRevision: 2 },
      { planDigest: 'old-plan' }, { buildGeneration: 1 }, { summaryDigest: 'tampered' },
    ]) {
      expect(() => store.createReceipt(result.runId, { ...expected, ...changed }, 'report.md'))
        .toThrow('UAT 凭证与当前候选提交或执行上下文不一致');
    }
  });
});
