import { DRAFT_FORMAT } from '../shared/runtime/formats.js';
import { parseJsonOutput } from '../prompts/parseJsonOutput.js';
import { ISSUE_LABELS } from '../clients/IssueLabels.js';
import type { DemandDraft } from '../shared/workbench.js';
export type { DemandDraft } from '../shared/workbench.js';
import { writeJsonAtomicSync } from '../utils/atomicFile.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AIRunner } from '../ai-runner/AIRunner.js';
import type { GitHubClient, GitHubIssue } from '../clients/GitHubClient.js';
import { AsyncMutex } from '../utils/AsyncMutex.js';
const draftInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10000),
  acceptanceCriteria: z.string().trim().min(1).max(5000),
});

function readDraft(file: string, id: string): DemandDraft {
  try {
    const draft: DemandDraft = JSON.parse(fs.readFileSync(file, 'utf8'));
    draftInput.parse(draft);
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      draft.format !== DRAFT_FORMAT ||
      draft.id !== id ||
      draft.marker !== `<!-- iaf-draft:${id} -->` ||
      !['draft', 'unknown', 'created'].includes(draft.status) ||
      typeof draft.createdAt !== 'string'
    )
      throw new Error('格式或标记无效');
    if (draft.status !== 'draft' && !draft.creationRequestedAt) throw new Error('缺少创建意图');
    if (draft.status === 'created' && (!Number.isSafeInteger(draft.issueIid) || !draft.issueUrl))
      throw new Error('缺少平台关联凭证');
    return draft;
  } catch (error) {
    throw new Error(
      `草稿文件 ${file} 无效：${(error as Error).message}。请使用新 DATA_DIR 或归档旧数据后重新初始化；原文件已保留。`,
    );
  }
}
export function validateDraftStorage(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json')))
    readDraft(path.join(directory, file), file.slice(0, -5));
}

/** 一份确认后的父需求创建一个 Issue；内部任务由该 Issue 的计划阶段生成。 */
export class DraftService {
  private mutex = new AsyncMutex();
  constructor(
    private directory: string,
    private runner: AIRunner,
    private client: Pick<GitHubClient, 'createIssue' | 'getIssueDetail' | 'listIssues'>,
    private workDir: string,
    private issueBaseUrl: string,
  ) {
    fs.mkdirSync(directory, { recursive: true });
    validateDraftStorage(directory);
  }
  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('草稿编号无效');
    return path.join(this.directory, id + '.json');
  }
  private save(draft: DemandDraft): void {
    writeJsonAtomicSync(this.file(draft.id), draft);
  }
  list(): DemandDraft[] {
    return fs
      .readdirSync(this.directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.get(file.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): DemandDraft {
    return readDraft(this.file(id), id);
  }
  async generate(input: string): Promise<DemandDraft> {
    if (!input.trim() || input.length > 20000) throw new Error('需求长度必须为 1～20000 字符');
    const result = await this.runner.run({
      workDir: this.workDir,
      mode: 'plan',
      phaseName: 'draft',
      timeoutMs: 120000,
      prompt: `整理为一个完整父需求，不拆成多个 Issue。仅返回 JSON：{"title":"标题","description":"完整说明","acceptanceCriteria":"验收标准"}。不修改代码。\n${input}`,
    });
    if (!result.success) throw new Error(result.errorMessage || '需求整理失败');
    const content = draftInput.parse(parseJsonOutput(result.output));
    const id = randomUUID();
    const draft: DemandDraft = {
      ...content,
      format: DRAFT_FORMAT,
      id,
      marker: `<!-- iaf-draft:${id} -->`,
      input,
      createdAt: new Date().toISOString(),
      status: 'draft',
    };
    this.save(draft);
    return draft;
  }
  async edit(id: string, input: unknown): Promise<DemandDraft> {
    return this.mutex.runExclusive(async () => {
      const draft = this.get(id);
      if (draft.status !== 'draft') throw new Error('已确认或结果未知的草稿不能修改');
      Object.assign(draft, draftInput.parse(input));
      this.save(draft);
      return draft;
    });
  }
  private verifyIssue(issue: GitHubIssue, draft: DemandDraft): void {
    if (
      !issue.description.includes(draft.marker) ||
      issue.html_url !== `${this.issueBaseUrl}/issues/${issue.number}`
    )
      throw new Error('关联 Issue 的仓库或草稿标记不匹配');
  }
  async confirm(id: string): Promise<DemandDraft> {
    return this.mutex.runExclusive(async () => {
      const draft = this.get(id);
      if (draft.status === 'created') return draft;
      if (draft.status === 'unknown')
        throw new Error('创建结果未知，请先核对；不能再次发送创建请求');
      draft.status = 'unknown';
      draft.creationRequestedAt = new Date().toISOString();
      this.save(draft);
      try {
        const issue = await this.client.createIssue(
          draft.title,
          `${draft.description}\n\n## 验收标准\n${draft.acceptanceCriteria}\n\n${draft.marker}`,
          [ISSUE_LABELS.root],
        );
        this.verifyIssue(issue, draft);
        Object.assign(draft, {
          status: 'created',
          issueIid: issue.number,
          issueUrl: issue.html_url,
          error: undefined,
        });
      } catch (error) {
        draft.error = (error as Error).message;
      }
      this.save(draft);
      return draft;
    });
  }
  async reconcile(id: string, number?: number | null): Promise<DemandDraft> {
    return this.mutex.runExclusive(async () => {
      const draft = this.get(id);
      if (draft.status !== 'unknown') throw new Error('当前草稿无需核对');
      try {
        if (number != null && (!Number.isInteger(number) || number <= 0))
          throw new Error('Issue 编号无效');
        const matches =
          number != null
            ? [await this.client.getIssueDetail(number)]
            : (await this.client.listIssues('all')).filter((issue) =>
                issue.description.includes(draft.marker),
              );
        if (matches.length !== 1)
          throw new Error(
            matches.length ? '存在多条匹配，需人工核对' : '尚无确定创建结果，保留未知状态',
          );
        this.verifyIssue(matches[0], draft);
        Object.assign(draft, {
          status: 'created',
          issueIid: matches[0].number,
          issueUrl: matches[0].html_url,
          error: undefined,
        });
      } catch (error) {
        draft.error = (error as Error).message;
      }
      this.save(draft);
      return draft;
    });
  }
}
