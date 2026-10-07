import { z } from 'zod';
import { UAT_FORMAT, VISUAL_CASES_FORMAT } from '../shared/runtime/formats.js';

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const visualCaseSchema = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  acceptanceRefs: z.array(z.string().min(1)).min(1),
  viewports: z.array(viewportSchema).min(1),
  expectedState: z.string().min(1),
}).strict();

export const visualCasesManifestSchema = z.object({
  format: z.literal(VISUAL_CASES_FORMAT),
  planDigest: z.string().min(1),
  cases: z.array(visualCaseSchema).min(1),
}).strict();

export const screenshotEvidenceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().length(64),
  testId: z.string(),
  projectName: z.string(),
  caseId: z.string(),
  sceneId: z.string(),
  viewport: viewportSchema,
  pageUrl: z.string(),
  acceptanceRefs: z.array(z.string()),
}).strict();

export const visualCoverageGapSchema = z.object({
  description: z.string().min(1),
  kind: z.enum([
    'missing-case',
    'missing-viewport',
    'missing-visible-state',
    'unreadable-image',
    'incomplete-agent-output',
  ]),
  acceptanceRefs: z.array(z.string()),
  caseId: z.string().optional(),
  sceneId: z.string().optional(),
  viewport: viewportSchema.optional(),
  screenshotIds: z.array(z.string()),
}).strict();

export const visualRepairGapSchema = visualCoverageGapSchema.extend({
  gapIndex: z.number().int().nonnegative(),
  sourceRunId: z.string().min(1),
}).strict();

const visualReviewCoverageGapSchema = visualCoverageGapSchema.extend({
  gapIndex: z.number().int().nonnegative().optional(),
  sourceRunId: z.string().min(1).optional(),
}).strict();

export const visualReviewResultSchema = z.object({
  status: z.enum(['not-run', 'pending', 'passed', 'failed', 'needs-review']),
  summary: z.string(),
  issues: z.array(z.object({
    screenshotId: z.string(),
    caseId: z.string(),
    sceneId: z.string(),
    viewport: viewportSchema,
    severity: z.enum(['blocker', 'major', 'minor']),
    screenshot: z.string(),
    description: z.string(),
    expected: z.string(),
    observed: z.string(),
  }).strict()),
  selectedScreenshots: z.array(z.string()),
  checkedScreenshots: z.array(z.string()),
  unreviewedScreenshots: z.array(z.string()),
  coverageGaps: z.array(z.string()),
  coverageGapDetails: z.array(visualReviewCoverageGapSchema).optional(),
  reviewRound: z.number().int().positive().optional(),
  maxReviewRounds: z.number().int().positive().optional(),
  reasonCode: z.string().optional(),
  requestedModel: z.string().optional(),
  actualModel: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
}).strict();

export const uatPolicySchema = z.object({
  visualReviewEnabled: z.boolean(),
  maxImages: z.number().int().nonnegative(),
  maxReviewRounds: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000),
}).strict();

export const uatExecutionSchema = z.object({
  candidateCommit: z.string().min(1),
  planRevision: z.number().int().nonnegative(),
  planDigest: z.string().min(1),
  buildGeneration: z.number().int().nonnegative(),
  dispatchId: z.string().min(1),
  phaseAttemptNo: z.number().int().nonnegative(),
  visualCallId: z.string().min(1).optional(),
}).strict();

export const uatEvidenceSchema = z.object({
  format: z.literal(UAT_FORMAT),
  summaryDigest: z.string().min(1),
  execution: uatExecutionSchema,
  policy: uatPolicySchema,
}).strict();

export const uatResultSchema = z.object({
  format: z.literal(UAT_FORMAT),
  status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
  runId: z.string().min(1),
  issueIid: z.number().int().positive(),
  machinePassed: z.boolean(),
  passed: z.boolean(),
  passedTests: z.number().int().nonnegative(),
  failedTests: z.number().int().nonnegative(),
  skippedTests: z.number().int().nonnegative(),
  evidence: z.array(screenshotEvidenceSchema),
  reportAvailable: z.boolean(),
  startedAt: z.string(),
  machineFinishedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  visualReview: visualReviewResultSchema,
  policy: uatPolicySchema,
  execution: uatExecutionSchema,
  summaryDigest: z.string().length(64).optional(),
  failureKind: z.enum(['assertion', 'environment']).optional(),
  error: z.string().optional(),
}).strict();
