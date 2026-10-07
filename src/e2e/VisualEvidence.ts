import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  ScreenshotEvidence,
  ViewportSize,
  VisualCase,
  VisualCoverageGap,
  VisualCasesManifest,
} from '../shared/workbench.js';
import {
  parsePlaywrightReport,
  visitPlaywrightResults,
  type PlaywrightTestResult,
} from './PlaywrightReportCodec.js';
import { visualCasesManifestSchema, viewportSchema } from './UatSchemas.js';

const metadataSchema = z.object({
  caseId: z.string().min(1),
  sceneId: z.string().min(1),
  viewport: viewportSchema,
  pageUrl: z.string(),
  acceptanceRefs: z.array(z.string().min(1)),
}).strict();

interface Attachment {
  name: string;
  path?: string;
  body?: string;
  contentType: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

export interface VisualAttachmentMetadata {
  caseId: string;
  sceneId: string;
  viewport: ViewportSize;
  pageUrl: string;
  acceptanceRefs: string[];
}

export interface VisualEvidenceCollection {
  evidence: ScreenshotEvidence[];
  errors: string[];
}

/** 当前 Issue 的视觉用例清单属于工作台运行数据，不写入业务工作树。 */
export function visualCasesPath(dataDir: string, issueIid: number): string {
  return path.join(dataDir, 'issues', String(issueIid), 'uat', 'visual-cases.json');
}

export function readVisualCases(
  file: string,
  planDigest: string,
  acceptanceRefs: Set<string>,
): VisualCasesManifest {
  if (!fs.existsSync(file)) throw new Error(`缺少视觉用例清单：${file}`);
  const parsed = visualCasesManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (parsed.planDigest !== planDigest) throw new Error('视觉用例清单与当前计划摘要不匹配');

  const ids = new Set<string>();
  for (const item of parsed.cases) {
    if (ids.has(item.id)) throw new Error(`视觉用例 ID 重复：${item.id}`);
    ids.add(item.id);
    for (const ref of item.acceptanceRefs) {
      if (!acceptanceRefs.has(ref)) {
        throw new Error(`视觉用例引用未知验收条目：${ref}`);
      }
    }
    const viewports = new Set(item.viewports.map((viewport) => (
      `${viewport.width}x${viewport.height}`
    )));
    if (viewports.size !== item.viewports.length) {
      throw new Error(`视觉用例视口重复：${item.id}`);
    }
  }
  return parsed;
}

export function readVisualCasesManifest(file: string) {
  if (!fs.existsSync(file)) return undefined;
  return visualCasesManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function readAttachmentBody(attachment: Attachment): unknown {
  if (!attachment.body) throw new Error('附件缺少 body');
  return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
}

function readInlineImage(attachment: Attachment): Buffer {
  if (!attachment.body) throw new Error('视觉附件缺少 body');
  const bytes = Buffer.from(attachment.body, 'base64');
  if (bytes.length === 0) throw new Error('视觉附件为空');
  return bytes;
}

function materializeInlineImage(
  attachment: Attachment,
  outputDir: string,
  index: number,
): string {
  if (attachment.contentType !== 'image/png') throw new Error('视觉附件必须是 image/png');
  const bytes = readInlineImage(attachment);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('单张视觉附件超过体积上限');
  const file = path.join(
    outputDir,
    'artifacts',
    `iaf-visual-${String(index).padStart(3, '0')}.png`,
  );
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}

function findVisualMetadata(
  result: PlaywrightTestResult,
): VisualAttachmentMetadata {
  const attachment = result.attachments.find((item) => item.name === 'iaf-visual-meta');
  if (!attachment) throw new Error('缺少 iaf-visual-meta 附件');
  if (attachment.contentType !== 'application/json' || attachment.path) {
    throw new Error('iaf-visual-meta 必须以内嵌 JSON body 提供');
  }
  return metadataSchema.parse(readAttachmentBody(attachment));
}

function safeArtifactPath(file: string, artifactsDir: string): string | undefined {
  const root = path.resolve(artifactsDir);
  const resolved = path.resolve(file);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  try {
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function collectScreenshotEvidence(
  report: unknown,
  outputDir: string,
): VisualEvidenceCollection {
  const artifactsDir = path.join(outputDir, 'artifacts');
  const evidence: ScreenshotEvidence[] = [];
  const errors: string[] = [];
  let index = 0;
  let totalImageBytes = 0;

  visitPlaywrightResults(parsePlaywrightReport(report), (result, spec, projectName) => {
    const attachments = result.attachments;
    const visual = attachments.find((attachment) => attachment.name === 'iaf-visual');
    const metadataAttachment = attachments.find((attachment) => attachment.name === 'iaf-visual-meta');
    if (!visual && !metadataAttachment) return;
    try {
      if (!visual) throw new Error('缺少 iaf-visual 附件');
      if (visual.path || visual.contentType !== 'image/png') {
        throw new Error('iaf-visual 必须以内嵌 PNG body 提供');
      }
      const metadata = findVisualMetadata(result);
      const materialized = materializeInlineImage(visual, outputDir, index + 1);
      const absolute = safeArtifactPath(materialized, artifactsDir);
      if (!absolute) throw new Error('视觉截图未写入 artifacts');
      const bytes = fs.readFileSync(absolute);
      totalImageBytes += bytes.length;
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('视觉附件总输入体积超限');
      const relative = path.relative(outputDir, absolute).split(path.sep).join('/');
      const id = `shot-${String(++index).padStart(3, '0')}`;
      evidence.push({
        id,
        path: relative,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        testId: spec.id,
        projectName,
        caseId: metadata.caseId,
        sceneId: metadata.sceneId,
        viewport: metadata.viewport,
        pageUrl: metadata.pageUrl,
        acceptanceRefs: metadata.acceptanceRefs,
      });
    } catch (error) {
      errors.push(`视觉证据无效（${spec.id}）：${(error as Error).message}`);
    }
  });

  return { evidence, errors };
}

function gap(
  description: string,
  kind: VisualCoverageGap['kind'],
  item?: VisualCase,
  viewport?: ViewportSize,
  screenshotIds: string[] = [],
): VisualCoverageGap {
  return {
    description,
    kind,
    acceptanceRefs: item?.acceptanceRefs ?? [],
    caseId: item?.id,
    sceneId: item?.sceneId,
    viewport,
    screenshotIds,
  };
}

export function validateEvidenceCoverage(
  cases: VisualCase[],
  evidence: ScreenshotEvidence[],
  maxImages: number,
): VisualCoverageGap[] {
  const gaps: VisualCoverageGap[] = [];
  const caseMap = new Map(cases.map((item) => [item.id, item]));
  const ids = new Set<string>();
  const combinations = new Set<string>();

  for (const shot of evidence) {
    if (ids.has(shot.id)) {
      gaps.push(gap(`截图 ID 重复：${shot.id}`, 'incomplete-agent-output'));
    }
    ids.add(shot.id);
    const item = caseMap.get(shot.caseId);
    if (!item) {
      gaps.push(gap(`截图引用未知视觉用例：${shot.caseId}`, 'missing-case'));
      continue;
    }
    const refsMatch = item.acceptanceRefs.length === shot.acceptanceRefs.length
      && item.acceptanceRefs.every((ref) => shot.acceptanceRefs.includes(ref));
    if (!refsMatch) {
      gaps.push(gap(
        `截图验收引用不完整：${shot.id}`,
        'incomplete-agent-output',
        item,
        shot.viewport,
        [shot.id],
      ));
    }
    const viewportMatch = item.viewports.some((viewport) => (
      viewport.width === shot.viewport.width && viewport.height === shot.viewport.height
    ));
    if (!viewportMatch) {
      gaps.push(gap(
        `截图视口不在用例清单中：${shot.id}`,
        'missing-viewport',
        item,
        shot.viewport,
        [shot.id],
      ));
    }
    const combination = `${shot.caseId}@${shot.viewport.width}x${shot.viewport.height}`;
    if (combinations.has(combination)) {
      gaps.push(gap(
        `截图场景与视口重复：${combination}`,
        'incomplete-agent-output',
        item,
        shot.viewport,
        [shot.id],
      ));
    }
    combinations.add(combination);
  }

  for (const item of cases) {
    for (const viewport of item.viewports) {
      const found = evidence.some((shot) => (
        shot.caseId === item.id
        && shot.viewport.width === viewport.width
        && shot.viewport.height === viewport.height
      ));
      if (!found) gaps.push(gap(
        `${item.id}@${viewport.width}x${viewport.height}`,
        'missing-viewport',
        item,
        viewport,
      ));
    }
  }

  const required = cases.reduce((count, item) => count + item.viewports.length, 0);
  if (required > maxImages) {
    gaps.push(gap(`必需视觉证据 ${required} 张超过图片上限 ${maxImages}`, 'missing-visible-state'));
  }
  if (!evidence.length) gaps.push(gap('本轮没有带有效元数据的视觉截图', 'missing-case'));
  return gaps;
}

export function selectEvidence(
  evidence: ScreenshotEvidence[],
  cases: VisualCase[],
  maxImages: number,
): { selected: ScreenshotEvidence[]; gaps: VisualCoverageGap[] } {
  const gaps = validateEvidenceCoverage(cases, evidence, maxImages);
  if (gaps.length) return { selected: [], gaps };

  const required = cases.flatMap((item) => item.viewports.map((viewport) => (
    evidence.find((shot) => (
      shot.caseId === item.id
      && shot.viewport.width === viewport.width
      && shot.viewport.height === viewport.height
    ))!
  )));
  const used = new Set(required.map((item) => item.id));
  const optional = evidence
    .filter((item) => !used.has(item.id))
    .sort((a, b) => `${a.path}|${a.id}`.localeCompare(`${b.path}|${b.id}`));
  return { selected: [...required, ...optional].slice(0, maxImages), gaps: [] };
}
