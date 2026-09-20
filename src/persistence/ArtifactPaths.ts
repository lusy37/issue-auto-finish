import path from 'node:path';
import { resolveDataDir } from '../paths.js';

/** 运行产物属于 Issue 数据目录，与项目 worktree 是否存在无关。 */
export function resolveIssueArtifactsDir(issueNumber: number, dataDir = resolveDataDir()): string {
  return path.resolve(dataDir, 'issues', String(issueNumber), 'artifacts');
}

/** 产物只接受文件名，不能借路径片段读写其他 Issue 或项目文件。 */
export function resolveIssueArtifactPath(issueNumber: number, filename: string, dataDir = resolveDataDir()): string {
  if (!filename || filename === '.' || filename === '..' || /[/\\\0:]/.test(filename)) {
    throw new Error('产物名称必须是单个文件名');
  }
  return path.join(resolveIssueArtifactsDir(issueNumber, dataDir), filename);
}
