import { isE2eEnabledForIssue } from '../e2e/E2eSettings.js';
import type {
  IssueProcessingContext,
  OrchestratorDeps,
} from '../orchestrator/IssueProcessingContext.js';
import { GitOperations } from '../git/GitOperations.js';
import { applyIssueLifecycleEvent } from '../tracker/IssueLifecycle.js';
import type { GitHubPullRequest } from '../clients/GitHubClient.js';
import type { DeliveryIdentity } from './contracts.js';
import { UatResultStore } from '../e2e/UatResultStore.js';

export function validatePullRequest(pr: GitHubPullRequest, identity: DeliveryIdentity): void {
  if (
    pr.source_branch !== identity.sourceBranch ||
    pr.target_branch !== identity.targetBranch ||
    pr.source_repository !== identity.repository ||
    pr.target_repository !== identity.repository ||
    !pr.description?.includes(identity.marker)
  )
    throw new Error('PR 的仓库、分支或稳定标记不匹配');
  if (pr.state === 'merged') throw new Error('原 PR 已合并，后续需求请新建 Issue');
  if (pr.state === 'closed') throw new Error('请先在 GitHub 重开原 PR，工作台不会另建 PR');
}

/** 交付的每一步都有独立意图和结果凭证；恢复时只核对及补齐尚未完成的步骤。 */
export async function deliverIssue(
  ctx: IssueProcessingContext,
  deps: OrchestratorDeps,
): Promise<string> {
  const number = ctx.issue.number;
  const git = new GitOperations(ctx.wtCtx.gitRootDir, deps.signal);
  const state = () => deps.tracker.get(number)!.run;
  const e2eEnabled = isE2eEnabledForIssue(number, deps.tracker, deps.config);
  const acceptance = e2eEnabled ? '验证与浏览器验收通过' : '代码验证通过，浏览器验收未启用';

  // 步骤 1：在交付前做最终防护，确保当前候选提交确实已经完成验收，并且没有发生被改写的风险。
  const check = async () => {
    deps.signal?.throwIfAborted();
    const run = state();
    if (
      run.stopIntent ||
      !run.candidateCommit ||
      run.verify?.passed !== true ||
      run.verify.commit !== run.candidateCommit ||
      Object.values(run.tasks).some(
        (task) => task.status !== 'merged' || !task.success || task.merge?.stage !== 'merged',
      ) ||
      !Object.keys(run.tasks).length
    )
      throw new Error('交付缺少当前候选提交的完整验收凭证');
    if (e2eEnabled) {
      if (!run.uat?.runId)
        throw new Error('交付缺少当前候选提交的浏览器验收凭证');
      new UatResultStore(deps.tracker.store.dataDir).assertCurrentReceipt(run.uat.runId, {
        candidateCommit: run.candidateCommit,
        planRevision: run.planRevision,
        planDigest: run.planDigest!,
        buildGeneration: run.buildGeneration,
        summaryDigest: run.uat.uatEvidence.summaryDigest,
        visualReviewEnabled: run.uat.uatEvidence.policy.visualReviewEnabled,
      });
    }
    if ((await git.head()) !== run.candidateCommit || (await git.hasChanges()))
      throw new Error('验收后的 HEAD 或工作目录已改变，禁止交付');
  };

  // 步骤 2：进入交付状态，并初始化交付上下文，记录本次交付的仓库、分支和稳定标记。
  await check();
  deps.tracker.transaction(number, (record) => {
    if (record.lifecycle.kind !== 'delivering') {
      applyIssueLifecycleEvent(record, { type: 'delivery-started' });
    }
    record.deliveryPending = true;
  });

  const commit = state().candidateCommit!;
  if (!state().delivery)
    deps.tracker.transaction(number, (record) => {
      record.run.delivery = {
        repository: deps.config.github.repository,
        issueNumber: number,
        sourceBranch: ctx.branchName,
        targetBranch: deps.config.project.baseBranch,
        marker: `<!-- iaf-pr:${deps.config.github.repository}:${number} -->`,
        creation: 'unstarted',
      };
    });

  // 步骤 3：恢复/核对已有 PR 身份。如果已绑定 PR，则校验源仓库、目标分支、稳定标记都符合当前 issue。
  let identity = state().delivery!;
  if (
    identity.repository !== deps.config.github.repository ||
    identity.issueNumber !== number ||
    identity.sourceBranch !== ctx.branchName
  )
    throw new Error('当前仓库或分支与已保存的 PR 身份不一致');

  let pr: GitHubPullRequest | undefined;
  if (identity.prNumber) {
    pr = await deps.github.getPullRequestDetail(identity.prNumber);
    validatePullRequest(pr, identity);
  } else {
    // 3.1：在已存在的 PR 列表里匹配稳定标记，避免重复创建相同 issue 的 PR。
    const matches = (await deps.github.listPullRequests()).filter((item) =>
      item.description?.includes(identity.marker),
    );
    if (matches.length > 1) throw new Error('稳定标记匹配多个 PR，请人工处理');
    if (matches.length === 1) {
      pr = await deps.github.getPullRequestDetail(matches[0].number);
      validatePullRequest(pr, identity);
      deps.tracker.transaction(number, (record) => {
        Object.assign(record.run.delivery!, {
          prNumber: pr!.number,
          prUrl: pr!.html_url,
          creation: 'confirmed',
        });
        record.prUrl = pr!.html_url;
      });
    } else if (identity.creation === 'unknown')
      throw new Error('PR 创建结果仍未知，请核对原请求，不能再次创建');
  }

  // 步骤 4：确认远端分支状态，防止覆盖其他人未记录的更新；必要时推送当前候选提交。
  await check();
  identity = state().delivery!;
  const remote = await git.remoteHead(identity.sourceBranch);
  if (remote !== identity.remoteCommit && !(identity.pushIntent?.commit === remote))
    throw new Error('远端分支存在未记录更新，请人工核对，禁止覆盖');
  if (remote !== commit) {
    deps.tracker.transaction(number, (record) => {
      record.run.delivery!.pushIntent = { commit, lease: remote };
    });
    await check();
    await git.pushAccepted(identity.sourceBranch, commit, remote);
  }
  deps.tracker.transaction(number, (record) => {
    record.run.delivery!.remoteCommit = commit;
    record.run.delivery!.pushedCommit = commit;
    record.run.delivery!.pushIntent = undefined;
  });

  // 步骤 5：如果还没有 PR，就创建一个，并把结果写入 tracker，确保后续恢复可继续追踪。
  if (!pr) {
    await check();
    deps.tracker.transaction(number, (record) => {
      record.run.delivery!.creation = 'unknown';
    });
    pr = await deps.github.createPullRequest({
      sourceBranch: identity.sourceBranch,
      targetBranch: identity.targetBranch,
      title: ctx.demand.title,
      description: `完成 #${number}\n\n所有内部任务完成；${acceptance}。\n候选提交：${commit}\n\n${identity.marker}`,
    });
    validatePullRequest(pr, identity);
    deps.tracker.transaction(number, (record) => {
      Object.assign(record.run.delivery!, {
        prNumber: pr!.number,
        prUrl: pr!.html_url,
        creation: 'confirmed',
      });
      record.prUrl = pr!.html_url;
    });
  }

  // 步骤 6：把交付证据写回 issue，形成真正的“交付完成”闭环，便于审计和恢复。
  await check();
  if (state().delivery!.issueWrittenCommit !== commit) {
    const marker = `<!-- iaf-delivery:${number}:${commit} -->`;
    const notes = await deps.github.listIssueNotes(number);
    const matches = notes.filter((note) => note.body.includes(marker));
    if (matches.length > 1) throw new Error('交付标记匹配多条 Issue 回写，请人工核对');
    if (!matches.length) {
      if (state().delivery!.issueWriteIntent?.commit === commit)
        throw new Error('Issue 回写结果仍未知，不能重复发送');
      deps.tracker.transaction(number, (record) => {
        record.run.delivery!.issueWriteIntent = {
          commit,
          marker,
          requestedAt: new Date().toISOString(),
        };
      });
      await deps.github.createIssueNote(
        number,
        `任务已完成，${acceptance}。PR：${pr.html_url}\n${marker}`,
      );
    }
    deps.tracker.transaction(number, (record) => {
      record.run.delivery!.issueWrittenCommit = commit;
      record.run.delivery!.issueWriteIntent = undefined;
      record.deliveryNoteWritten = true;
    });
  }

  return pr.html_url;
}
