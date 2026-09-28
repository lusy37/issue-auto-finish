import type { Config } from '../config.js';
import type { IssueTracker } from '../tracker/IssueTracker.js';
import { t } from '../i18n/index.js';

let noteSyncOverride: boolean | undefined;

export function getNoteSyncEnabled(cfg: Config): boolean {
  return noteSyncOverride ?? cfg.issueNoteSync.enabled;
}

export function setNoteSyncOverride(value: boolean | undefined): void {
  noteSyncOverride = value;
}

export function isNoteSyncEnabledForIssue(
  issueIid: number,
  tracker: IssueTracker,
  cfg: Config,
): boolean {
  const record = tracker.get(issueIid);
  if (record?.issueNoteSyncEnabled !== undefined) return record.issueNoteSyncEnabled;
  return getNoteSyncEnabled(cfg);
}

const SUMMARY_MAX_LENGTH = 500;

export function truncateToSummary(content: string): string {
  if (content.length <= SUMMARY_MAX_LENGTH) return content;
  const cut = content.slice(0, SUMMARY_MAX_LENGTH);
  const lastNewline = cut.lastIndexOf('\n\n');
  const boundary = lastNewline > SUMMARY_MAX_LENGTH * 0.3 ? lastNewline : cut.lastIndexOf('\n');
  const summary = boundary > SUMMARY_MAX_LENGTH * 0.3 ? cut.slice(0, boundary) : cut;
  return summary + '\n\n...';
}

export interface ResultFileSpec {
  filename: string;
  label: string;
}

export function buildNoteSyncComment(
  phaseName: string,
  phaseLabel: string,
  docUrl: string,
  dashboardUrl: string,
  summary: string,
): string {
  const emoji: Record<string, string> = {
    verify: '✅',
    uat: '🧪',
    plan: '📋',
    review: '👀',
    build: '🔨',
  };
  const icon = emoji[phaseName] || '📋';
  return [
    t('notesync.phaseCompleted', { icon, label: phaseLabel }),
    '',
    summary,
    '',
    '---',
    t('notesync.viewDoc', { label: phaseLabel, url: docUrl }),
    t('notesync.viewDashboard', { url: dashboardUrl }),
  ].join('\n');
}
