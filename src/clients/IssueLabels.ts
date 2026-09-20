export const ISSUE_LABELS = {
  root: 'auto-finish',
  processing: 'auto-finish:processing',
  failed: 'auto-finish:failed',
  done: 'auto-finish:done',
} as const;

/** 仅管理精确根标签和冒号命名空间，保留 auto-finish-tools 等无关标签。 */
export function isWorkbenchLabel(label: string): boolean {
  return label === ISSUE_LABELS.root || label.startsWith(`${ISSUE_LABELS.root}:`);
}

export function withWorkbenchLabels(labels: readonly string[], owned: readonly string[]): string[] {
  return [...labels.filter(label => !isWorkbenchLabel(label)), ...owned];
}
