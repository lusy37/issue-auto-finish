import type { GitHubIssue } from '../../clients/GitHubClient.js';
import type { DemandSpec } from '../DemandSpec.js';
import type { SupplementInfo } from '../../supplement/SupplementStore.js';

/**
 * 将GitHub Issue 转换为 DemandSpec 值对象。
 *
 * @param issue  GitHub Issue 原始数据
 * @param supplement  可选的补充信息（来自 SupplementStore）
 */
export function githubIssueToDemandSpec(
  issue: GitHubIssue,
  supplement?: SupplementInfo | null,
): DemandSpec {
  return {
    demandId: `gh-${issue.number}`,
    sourceRef: {
      source: 'github-issue',
      externalId: String(issue.number),
      displayId: String(issue.number),
    },
    title: issue.title,
    description: issue.description ?? '',
    supplement: supplement ? mapSupplement(supplement) : undefined,
    createdAt: issue.created_at ?? new Date().toISOString(),
  };
}

function mapSupplement(s: SupplementInfo): DemandSpec['supplement'] {
  const result: Record<string, string | undefined> = {};
  if (s.requirements?.trim()) result.requirements = s.requirements.trim();
  if (s.acceptanceCriteria?.trim()) result.acceptanceCriteria = s.acceptanceCriteria.trim();
  if (s.scope?.trim()) result.scope = s.scope.trim();
  if (s.constraints?.trim()) result.constraints = s.constraints.trim();
  if (s.references?.trim()) result.references = s.references.trim();
  if (s.freeText?.trim()) result.freeText = s.freeText.trim();
  return Object.keys(result).length > 0 ? result : undefined;
}
