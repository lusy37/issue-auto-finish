export const zhCN: Record<string, string> = {
  'phase.verify': '验证',
  'phase.plan': '规划',
  'phase.build': '实施',
  'phase.uat': 'UAT验证',
  'phase.review': '审核',
  'pipeline.phase.verify': '验证',
  'pipeline.phase.plan': '规划',
  'pipeline.phase.review': '审核',
  'pipeline.phase.build': '实施',
  'pipeline.phase.uat': 'UAT验证',
  'planFile.01-plan.md': '实施计划',
  'planFile.02-verify-report.md': '验证报告',
  'planFile.03-uat-report.md': '浏览器验收报告',
  'planFile.review-feedback.md': '审核反馈',
  'planFile.review-history.json': '审核历史',

  // State labels (from collectStateLabels)
  'state.pending': '待处理',
  'state.skipped': '已跳过',
  'state.branchCreated': '分支已创建',
  'state.completed': '已完成',
  'state.failed': '失败',
  'state.resolvingConflict': '冲突修复中',
  'state.phaseDoing': '{label}中',
  'state.phaseDone': '{label}完成',
  'state.phaseWaiting': '待{label}',
  'state.phaseApproved': '{label}通过',
  'state.paused': '已暂停',

  // Orchestrator messages
  'orchestrator.retryComment': '🔄 **自动处理重试中**\n\n检测到之前处理失败，正在重试...',
  'orchestrator.startComment':
    '🚀 **自动处理开始**\n\n已检测到 `auto-finish` 标签，开始自动分析和实施。',
  'orchestrator.fetchProgress': '正在拉取最新代码...',
  'orchestrator.worktreeProgress': '正在准备工作目录...',
  'orchestrator.installProgress': '正在安装项目依赖 (npm install)...',
  'orchestrator.initPlanProgress': '正在初始化计划目录...',
  'orchestrator.phaseStartProgress': '准备就绪，开始执行阶段 (从 {phase} 开始)...',
  'orchestrator.autoApproveComment':
    '⚡ **审核自动通过**\n\n检测到标签匹配 `autoApproveLabels` 配置，已自动跳过审核进入实施阶段。',
  'orchestrator.createPrProgress': '正在创建合并请求...',
  'orchestrator.uploadScreenshotsProgress': '正在上传 E2E 截图...',
  'orchestrator.mrSection': '\n\n🔗 合并请求: {prUrl}',
  'orchestrator.mrFailSection': '\n\n⚠️ 合并请求创建失败，请手动创建。',
  'orchestrator.completedComment':
    '✅ **自动处理完成**\n\n所有阶段已完成。分支: `{branch}`{mrSection}{previewSection}',
  'orchestrator.failedComment':
    '❌ **自动处理失败**\n\n{error}\n\n将在下次轮询时重试（如果未超过最大重试次数）。',
  'orchestrator.deployProgress': '正在启动 Preview 环境...',
  'orchestrator.deployDoneProgress': 'Preview 环境已就绪: {url}',
  'orchestrator.previewComment.title': '🌐 **Preview Environment 已就绪**',
  'orchestrator.previewComment.tableHeader': '| 组件 | 地址 |',
  'orchestrator.previewComment.tableSep': '|------|------|',
  'orchestrator.previewComment.frontend': '前端',
  'orchestrator.previewComment.backendApi': '后端 API',
  'orchestrator.previewComment.hint': '可直接访问前端链接体验本次变更。',
  'orchestrator.previewComment.expiry': 'Preview 将在 PR 合并后自动清理，或 {hours}h 后过期。',

  // BasePhase messages
  'basePhase.aiStarting': '正在启动 AI Agent ({label})...',
  'basePhase.aiResuming': '正在恢复上一次中断的 AI 会话 ({label})...',
  'basePhase.resumePrompt':
    '上一次执行因中断而终止。请检查当前工作目录中已有的进度（包括已修改的文件和产物），从中断处继续完成任务。不要重复已经完成的工作。',
  'basePhase.resumeFallback': '会话恢复失败，降级为全新执行',
  'basePhase.rulesSection':
    '## 项目开发规范参考\n以下是与本次任务相关的开发规范，请在编码时严格遵循：\n\n{rules}',
  'basePhase.error': '错误: {message}',

  // IssuePoller messages
  'poller.autoApproveComment':
    '⚡ **审核自动通过**\n\n检测到标签匹配 `autoApproveLabels` 配置（匹配: {labels}），已自动跳过审核进入实施阶段。',

  // Progress comment
  'progress.completed': '已完成',
  'progress.failed': '失败',
  'progress.inProgress': '进行中',
  'progress.comment': '{icon} **自动处理进度更新**\n\n阶段: **{phase}** — {status}',

  // NoteSync messages
  'notesync.phaseCompleted': '{icon} **{label}阶段完成**',
  'notesync.viewDoc': '📄 [查看完整{label}文档]({url})',
  'notesync.viewDashboard': '📊 [在管理面板中查看详情]({url})',

  // PullRequest messages
  'pr.relatedIssue': '## 关联 Issue',
  'pr.title': '标题',
  'pr.branch': '分支',
  'pr.issueDescription': '## Issue 描述',
  'pr.noDescription': '（无描述）',
  'pr.summaryFiles.01-plan.md': '实施计划',
  'pr.summaryFiles.02-verify-report.md': '验证报告',
  'pr.aiSummary': '## AI 产物摘要',
  'pr.autoCreated': '*此 PR 由 Issue Auto-Finish 系统自动创建*',
  'pr.truncated': '...（已截断）',

  // Screenshot messages
  'screenshot.title': '📸 **E2E 测试截图**',
  'screenshot.truncated': '> ⚠️ 截图数量过多，仅展示前 20 张。',
  'reaper.reaped': '已自动清理 Issue #{number} 的过期 Preview 环境（已运行 {hours}h）。',
  'reaper.summary': '本次清理了 {count} 个过期 Preview 环境。',

  // API routes
  'api.invalidFilename': '无效的文件名',
  'api.docNotGenerated': '文档尚未生成',
  'api.viewInDashboard': '在管理面板中查看',
  'api.reviewFeedback': '👀 **方案审核反馈（第 {round} 轮）**',
  'api.viewPlan': '📄 [查看实施计划]({url})',
  'api.viewDetail': '📊 [在管理面板中查看详情]({url})',
  'docLabel.01-plan.md': '实施计划',
  'docLabel.02-verify-report.md': '验证报告',
  'docLabel.review-feedback.md': '审核反馈',

  'prompt.plan': `你是资深技术负责人。请一次性完成需求分析和方案设计。

## Issue 信息
- IID: #{number}
- 标题: {title}
- 描述:
{description}{supplement}

## 输出要求
请先阅读项目根目录的 AGENTS.md 了解项目架构，再进行分析和设计。

{outputInstruction}

### 第一部分：需求分析
1. **需求概述** — 用简洁的语言总结需求目标
2. **功能点拆解** — 列出需要实现的具体功能点
3. **影响范围分析** — 哪些模块/文件可能受到影响
4. **非功能需求** — 性能、安全、兼容性等方面的考量
5. **风险和依赖** — 潜在风险和外部依赖

### 第二部分：系统设计
1. **方案概述** — 整体设计思路
2. **涉及的文件和模块** — 需要新建/修改的文件列表
3. **数据模型变更** — 数据库或模型层的变更
4. **接口设计** — API 接口定义
5. **详细实施步骤** — 按顺序列出实施步骤

### 第三部分：内部任务图
将上述分析和设计写入 description。每个任务使用 id、title、instructions、acceptanceCriteria、dependsOn 字段；明确任务产物和验收标准，只引用已定义的任务 ID。
完整计划使用 title、description、acceptanceCriteria、tasks 字段，最终只返回严格 JSON，不输出 Markdown 文档。
{outputConstraint}`,

  'prompt.rePlan': `你是资深技术负责人。之前的实施计划未通过审核，请根据审核反馈修改计划。

## Issue 信息
- IID: #{number}
- 标题: {title}
- 描述:
{description}{supplement}

## 审核反馈历史（共 {historyCount} 轮）
{feedbackLines}{rejectedPlanSection}

{rePlanReadInstruction}

## 输出要求
{rePlanOutputInstruction}
重点关注最新一轮的反馈，同时确保之前轮次提出的问题也已得到解决。
{outputConstraint}`,

  'prompt.rePlanRound': '### 第 {round} 轮 ({timestamp})\n{feedback}',

  'prompt.rePlanResume': `你刚才在本次会话中提交的实施计划没有通过审核。

## 本轮反馈
{latestFeedback}

## 全部审核历史（共 {historyCount} 轮）
{allRoundsLines}{supplement}

请在你刚才提交的方案基础上做实质性修改：
- 针对每条反馈给出可验证的调整（说明改了什么、为什么、影响范围）
- 不要原样照搬之前的方案，也不要只做措辞润色
- 避免空洞口号（如"提升健壮性"），代之以具体的设计/接口/步骤/验收标准

请提交完整的修订版实施计划。`,

  'prompt.e2eSuffix.title': '## E2E UI 验证（已启用）',
  'prompt.e2eSuffix.intro': '本次变更已开启 E2E UI 自动验收，请额外执行以下步骤：',
  'prompt.e2eSuffix.previewNote': '**Preview 环境已启动（由系统管理，无需手动启动）：**',
  'prompt.e2eSuffix.backend': '后端',
  'prompt.e2eSuffix.frontend': '前端',

  // Conflict resolution
  'conflict.startComment':
    '🔧 **合并冲突修复开始**\n\n正在尝试将分支 `{branch}` rebase 到最新的 `{baseBranch}`...',
  'conflict.noConflictComment':
    '✅ **Rebase 成功，没有冲突**\n\n分支 `{branch}` 已成功 rebase 到最新的 `{baseBranch}`，无需冲突修复。',
  'conflict.resolvedComment':
    '✅ **合并冲突修复完成**\n\n分支 `{branch}` 已成功 rebase 到最新的 `{baseBranch}`，所有冲突已自动解决并通过验证。',
  'conflict.failedComment': '❌ **合并冲突修复失败**\n\n{error}\n\n请在工作台中重试冲突修复。',
  'conflict.mrResolvedComment':
    '✅ **合并冲突已自动修复**\n\n此 PR 的源分支已成功 rebase 到最新的目标分支，冲突已自动解决。请重新审查变更。',
  'conflict.startedMsg': '🔧 冲突修复已启动，处理中请稍候...',
  'conflict.invalidState':
    '当前状态不允许冲突修复（当前: {state}）。仅在 Completed 或冲突修复失败后可触发。',
  'conflict.noMr': 'Issue #{number} 没有关联的 PR，无法执行冲突修复。',

  // Auto-update messages
  'update.checking': '正在检查更新...',
  'update.available': '发现新版本: v{latestVersion} (当前: v{currentVersion})',
  'update.upToDate': '当前已是最新版本 (v{currentVersion})',
  'update.draining': '正在等待活跃 Issue 完成...',
  'update.updating': '正在更新到 v{version}...',
  'update.completed': '更新完成，服务将自动重启',
  'update.failed': '更新失败: {error}',

  // Distill (知识蒸馏)
  'distill.diaryCreated': '📝 已记录 Issue #{number} 的经验日记（{outcome}）',
  'distill.started': '🧪 知识蒸馏开始...',
  'distill.completed':
    '✅ 知识蒸馏完成 — 记忆: {memoryActions} 条, 规则: {ruleActions} 条, 向量: {vectorIndexed} 条',
  'distill.failed': '❌ 知识蒸馏失败: {error}',
  'distill.runEmpty': '暂无可蒸馏的日记数据',
  'distill.noUndistilled': '暂无未蒸馏的日记（最少需要 {threshold} 条）',
  'distill.statusTitle': '📊 **知识蒸馏状态**',
  'distill.statusDiaries': '日记: {total} 条（未蒸馏: {undistilled} 条）',
  'distill.statusMemories': '记忆: {count} 条',
  'distill.statusRules': '规则: {count} 条',
  'distill.statusVectors': '向量索引: {count} 条',
  'distill.statusLastRun': '上次蒸馏: {time}',
  'distill.statusNeverRun': '上次蒸馏: 尚未执行',
  'distill.triggerSuccess': '🧪 知识蒸馏已触发，处理中请稍候...',

  // Build fix mode suffix (verify-fix loop)

  // --- E2E Runner ---
  'e2e.runnerCreated': 'E2E 验证阶段将使用独立 AI Runner（{mode}）',
  'e2e.runnerFallback': 'E2E AI Runner 二进制（{binary}）未安装，回退使用主 Runner',
};
