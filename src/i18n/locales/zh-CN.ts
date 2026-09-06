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
  'planFile.03-uat-report.md': 'UAT验证报告',
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
  'orchestrator.startComment': '🚀 **自动处理开始**\n\n已检测到 `auto-finish` 标签，开始自动分析和实施。',
  'orchestrator.fetchProgress': '正在拉取最新代码...',
  'orchestrator.worktreeProgress': '正在准备工作目录...',
  'orchestrator.installProgress': '正在安装项目依赖 (npm install)...',
  'orchestrator.initPlanProgress': '正在初始化计划目录...',
  'orchestrator.phaseStartProgress': '准备就绪，开始执行阶段 (从 {phase} 开始)...',
  'orchestrator.autoApproveComment': '⚡ **审核自动通过**\n\n检测到标签匹配 `autoApproveLabels` 配置，已自动跳过审核进入实施阶段。',
  'orchestrator.createPrProgress': '正在创建合并请求...',
  'orchestrator.uploadScreenshotsProgress': '正在上传 E2E 截图...',
  'orchestrator.mrSection': '\n\n🔗 合并请求: {prUrl}',
  'orchestrator.mrFailSection': '\n\n⚠️ 合并请求创建失败，请手动创建。',
  'orchestrator.completedComment': '✅ **自动处理完成**\n\n所有阶段已完成。分支: `{branch}`{mrSection}{previewSection}',
  'orchestrator.failedComment': '❌ **自动处理失败**\n\n{error}\n\n将在下次轮询时重试（如果未超过最大重试次数）。',
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
  'basePhase.resumePrompt': '上一次执行因中断而终止。请检查当前工作目录中已有的进度（包括已修改的文件和产物），从中断处继续完成任务。不要重复已经完成的工作。',
  'basePhase.resumeFallback': '会话恢复失败，降级为全新执行',
  'basePhase.rulesSection': '## 项目开发规范参考\n以下是与本次任务相关的开发规范，请在编码时严格遵循：\n\n{rules}',
  'basePhase.error': '错误: {message}',

  // IssuePoller messages
  'poller.autoApproveComment': '⚡ **审核自动通过**\n\n检测到标签匹配 `autoApproveLabels` 配置（匹配: {labels}），已自动跳过审核进入实施阶段。',

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

  'prompt.planModeVerify': `你是**严格的**测试工程师。验证代码变更的正确性。

## Issue 信息
- IID: #{number}
- 标题: {title}

## 幂等性检查（最先执行）
在执行任何操作之前，先检查是否已存在验证报告：
1. 读取 {planDir}/02-verify-report.md（如果存在）
2. 如果报告存在且"总结"部分包含"验证通过"，则**直接结束**，不要重复执行任何验证步骤
3. 如果报告不存在或总结为"验证失败"，继续执行下面的验证步骤

**重要**：此检查的目的是防止重复执行导致破坏性操作（如删除已通过的测试文件）。

## 前置检查
在执行验证前，先确认依赖环境:
1. 检查 {dependencyCheckPath} 是否存在
2. 如不存在，运行 {installCommand}；如果失败，尝试 {installFallbackCommand}
3. 如果依赖始终无法安装完整，在报告中标注为"环境问题"并继续后续检查

## 验证步骤
1. 运行 {lintCommand} 检查代码风格
2. 运行 {buildCommand} 检查编译
3. 运行 {testFilesCommand} 运行相关测试
4. 检查代码变更与 {planDir}/01-plan.md 实施计划的一致性
5. **严格检查** {planDir}/01-plan.md 中 Todolist 是否**所有项**都已完成（- [x]）

## 已知的预存问题（忽略即可）
{knownIssuesSection}
- 如果某个 lint/build/test 的失败**不涉及本次变更的文件**，标注为"预存问题"

## 验证标准（必须全部满足才算通过）
- Lint 零错误（本次变更相关）
- Build 成功
- 所有测试通过
- Todolist 100% 完成（无未勾选项）
- 代码符合实施计划

将验证结果写入 {planDir}/02-verify-report.md，**必须**包括以下各节：
- **Lint 结果**: 通过/失败 + 详情（区分本次变更 vs 预存问题）
- **Build 结果**: 通过/失败 + 详情（区分本次变更 vs 预存问题）
- **Test 结果**: 通过/失败 + 详情
- **Todolist 检查**: X/Y 项完成 + 未完成项列表
- **计划一致性检查**: 是否符合实施计划
- **总结**: 验证通过/验证失败 + 具体原因

**重要**: 如果任何一项检查失败，必须在"总结"中明确写"验证失败"。`,

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

### 第三部分：实施 Todolist
- [ ] 步骤1: 具体描述
- [ ] 步骤2: 具体描述
...

请确保 Todolist 足够详细，每个步骤可独立执行和验证。
{outputConstraint}`,

  'prompt.build': `你是开发工程师。请按照实施计划完成代码变更。

## Issue 信息
- IID: #{number}
- 标题: {title}

请先阅读:
- {planDir}/01-plan.md (完整实施计划，包含需求分析、系统设计和 Todolist)
- AGENTS.md (项目架构和代码规范)

## 实施要求
1. 严格按照 01-plan.md 中的 Todolist 逐项完成
2. 每完成一项，更新 01-plan.md 中对应的勾选状态 (- [ ] → - [x])
3. 严格遵循 AGENTS.md 中的代码规范（{codeStyleDescription}）
4. 不要过度工程化，只实现计划中要求的内容
5. 确保代码安全，避免 OWASP Top 10 漏洞`,

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
  'conflict.startComment': '🔧 **合并冲突修复开始**\n\n正在尝试将分支 `{branch}` rebase 到最新的 `{baseBranch}`...',
  'conflict.noConflictComment': '✅ **Rebase 成功，没有冲突**\n\n分支 `{branch}` 已成功 rebase 到最新的 `{baseBranch}`，无需冲突修复。',
  'conflict.resolvedComment': '✅ **合并冲突修复完成**\n\n分支 `{branch}` 已成功 rebase 到最新的 `{baseBranch}`，所有冲突已自动解决并通过验证。',
  'conflict.failedComment': '❌ **合并冲突修复失败**\n\n{error}\n\n请在工作台中重试冲突修复。',
  'conflict.mrResolvedComment': '✅ **合并冲突已自动修复**\n\n此 PR 的源分支已成功 rebase 到最新的目标分支，冲突已自动解决。请重新审查变更。',
  'conflict.startedMsg': '🔧 冲突修复已启动，处理中请稍候...',
  'conflict.invalidState': '当前状态不允许冲突修复（当前: {state}）。仅在 Completed 或冲突修复失败后可触发。',
  'conflict.noMr': 'Issue #{number} 没有关联的 PR，无法执行冲突修复。',

  // Auto-update messages
  'update.checking': '正在检查更新...',
  'update.available': '发现新版本: v{latestVersion} (当前: v{currentVersion})',
  'update.upToDate': '当前已是最新版本 (v{currentVersion})',
  'update.draining': '正在等待活跃 Issue 完成...',
  'update.updating': '正在更新到 v{version}...',
  'update.completed': '更新完成，服务将自动重启',
  'update.failed': '更新失败: {error}',

  'prompt.conflictResolve': `你是一名资深开发工程师，正在处理 Git rebase 过程中产生的合并冲突。

## 背景
- Issue IID: #{number}
- 分支: \`{branch}\` 正在 rebase 到 \`{baseBranch}\`
- 冲突文件列表:
{conflictFilesList}

## 任务
请逐一解决上述冲突文件：

1. 打开每个冲突文件，仔细阅读冲突标记（<<<<<<< HEAD / ======= / >>>>>>> ...）
2. 理解双方修改的意图：
   - HEAD（当前分支）的修改目的
   - 对方分支的修改目的
3. 正确合并代码，确保：
   - 保留双方有意义的修改
   - 完全移除所有冲突标记（<<<<<<<, =======, >>>>>>>）
   - 合并后的代码逻辑完整、可编译、可运行
4. 如果某个文件的冲突涉及结构性变更（如函数签名变化），确保所有引用处也同步更新

## 注意事项
- 不要遗漏任何冲突标记
- 不要引入新的 bug
- 保持代码风格一致
- 只修改冲突文件，不要做额外的代码改动`,

  // Distill (知识蒸馏)
  'distill.diaryCreated': '📝 已记录 Issue #{number} 的经验日记（{outcome}）',
  'distill.started': '🧪 知识蒸馏开始...',
  'distill.completed': '✅ 知识蒸馏完成 — 记忆: {memoryActions} 条, 规则: {ruleActions} 条, 向量: {vectorIndexed} 条',
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
  'prompt.buildFixSuffix': `

## ⚠️ 修复模式（第 {iteration} 轮修复）

**重要**: 上一轮验证发现以下问题未通过，请在本轮优先修复：

{failures}

### 修复要求
1. 仔细阅读验证报告中的具体错误信息
2. 修复所有导致 lint/build/test 失败的问题
3. 完成所有 Todolist 中未完成的项目（- [ ] → - [x]），特别是新增单测
4. 不要引入新的问题
5. 修复完成后确保 {lintCommand} 和 {buildCommand} 和 {testFilesCommand} 全部通过

### 原始验证报告摘要
\`\`\`
{rawReport}
\`\`\`
`,

  // --- E2E Runner ---
  'e2e.runnerCreated': 'E2E 验证阶段将使用独立 AI Runner（{mode}）',
  'e2e.runnerFallback': 'E2E AI Runner 二进制（{binary}）未安装，回退使用主 Runner',
};
