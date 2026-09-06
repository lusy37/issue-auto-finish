export const en: Record<string, string> = {
  'phase.verify': 'Verification',
  'phase.plan': 'Planning',
  'phase.build': 'Build',
  'phase.uat': 'UAT Verification',
  'phase.review': 'Review',
  'pipeline.phase.verify': 'Verification',
  'pipeline.phase.plan': 'Planning',
  'pipeline.phase.review': 'Review',
  'pipeline.phase.build': 'Build',
  'pipeline.phase.uat': 'UAT Verification',
  'planFile.01-plan.md': 'Implementation Plan',
  'planFile.02-verify-report.md': 'Verification Report',
  'planFile.03-uat-report.md': 'UAT Report',
  'planFile.review-feedback.md': 'Review Feedback',
  'planFile.review-history.json': 'Review History',

  // State labels
  'state.pending': 'Pending',
  'state.skipped': 'Skipped',
  'state.branchCreated': 'Branch Created',
  'state.completed': 'Completed',
  'state.failed': 'Failed',
  'state.resolvingConflict': 'Resolving Conflict',
  'state.phaseDoing': '{label} In Progress',
  'state.phaseDone': '{label} Done',
  'state.phaseWaiting': 'Awaiting {label}',
  'state.phaseApproved': '{label} Approved',
  'state.paused': 'Paused',

  // Orchestrator messages
  'orchestrator.retryComment': '🔄 **Auto-processing Retry**\n\nPrevious processing failed, retrying...',
  'orchestrator.startComment': '🚀 **Auto-processing Started**\n\nDetected `auto-finish` label, starting automated analysis and implementation.',
  'orchestrator.fetchProgress': 'Fetching latest code...',
  'orchestrator.worktreeProgress': 'Preparing working directory...',
  'orchestrator.installProgress': 'Installing project dependencies (npm install)...',
  'orchestrator.initPlanProgress': 'Initializing plan directory...',
  'orchestrator.phaseStartProgress': 'Ready, starting phases (from {phase})...',
  'orchestrator.autoApproveComment': '⚡ **Review Auto-approved**\n\nDetected label matching `autoApproveLabels` configuration, automatically skipping review and proceeding to implementation.',
  'orchestrator.createPrProgress': 'Creating merge request...',
  'orchestrator.uploadScreenshotsProgress': 'Uploading E2E screenshots...',
  'orchestrator.mrSection': '\n\n🔗 Merge Request: {prUrl}',
  'orchestrator.mrFailSection': '\n\n⚠️ Failed to create merge request, please create manually.',
  'orchestrator.completedComment': '✅ **Auto-processing Completed**\n\nAll phases completed. Branch: `{branch}`{mrSection}{previewSection}',
  'orchestrator.failedComment': '❌ **Auto-processing Failed**\n\n{error}\n\nWill retry on next poll cycle (if max retries not exceeded).',
  'orchestrator.deployProgress': 'Starting Preview environment...',
  'orchestrator.deployDoneProgress': 'Preview environment ready: {url}',
  'orchestrator.previewComment.title': '🌐 **Preview Environment Ready**',
  'orchestrator.previewComment.tableHeader': '| Component | Address |',
  'orchestrator.previewComment.tableSep': '|-----------|---------|',
  'orchestrator.previewComment.frontend': 'Frontend',
  'orchestrator.previewComment.backendApi': 'Backend API',
  'orchestrator.previewComment.hint': 'Visit the frontend link to experience the changes.',
  'orchestrator.previewComment.expiry': 'Preview will be cleaned up after PR merge, or expires in {hours}h.',

  // BasePhase messages
  'basePhase.aiStarting': 'Starting AI Agent ({label})...',
  'basePhase.aiResuming': 'Resuming previous AI session ({label})...',
  'basePhase.resumePrompt': 'The previous execution was interrupted. Please check the existing progress in the working directory (including modified files and artifacts), and continue from where it left off. Do not repeat work that has already been completed.',
  'basePhase.resumeFallback': 'Session resume failed, falling back to fresh execution',
  'basePhase.rulesSection': '## Project Development Guidelines\nThe following are development guidelines related to this task. Please strictly follow them when coding:\n\n{rules}',
  'basePhase.error': 'Error: {message}',

  // IssuePoller messages
  'poller.autoApproveComment': '⚡ **Review Auto-approved**\n\nDetected label matching `autoApproveLabels` configuration (matched: {labels}), automatically skipping review and proceeding to implementation.',

  // Progress comment
  'progress.completed': 'Completed',
  'progress.failed': 'Failed',
  'progress.inProgress': 'In Progress',
  'progress.comment': '{icon} **Auto-processing Progress Update**\n\nPhase: **{phase}** — {status}',

  // NoteSync messages
  'notesync.phaseCompleted': '{icon} **{label} Phase Completed**',
  'notesync.viewDoc': '📄 [View full {label} document]({url})',
  'notesync.viewDashboard': '📊 [View details in dashboard]({url})',

  // PullRequest messages
  'pr.relatedIssue': '## Related Issue',
  'pr.title': 'Title',
  'pr.branch': 'Branch',
  'pr.issueDescription': '## Issue Description',
  'pr.noDescription': '(No description)',
  'pr.summaryFiles.01-plan.md': 'Implementation Plan',
  'pr.summaryFiles.02-verify-report.md': 'Verification Report',
  'pr.aiSummary': '## AI Artifacts Summary',
  'pr.autoCreated': '*This PR was automatically created by Issue Auto-Finish system*',
  'pr.truncated': '...(truncated)',

  // Screenshot messages
  'screenshot.title': '📸 **E2E Test Screenshots**',
  'screenshot.truncated': '> ⚠️ Too many screenshots, showing only the first 20.',
  'reaper.reaped': 'Auto-cleaned expired preview for Issue #{number} (ran for {hours}h).',
  'reaper.summary': 'Cleaned up {count} expired preview environment(s).',

  // API routes
  'api.invalidFilename': 'Invalid filename',
  'api.docNotGenerated': 'Document not yet generated',
  'api.viewInDashboard': 'View in dashboard',
  'api.reviewFeedback': '👀 **Plan Review Feedback (Round {round})**',
  'api.viewPlan': '📄 [View implementation plan]({url})',
  'api.viewDetail': '📊 [View details in dashboard]({url})',
  'docLabel.01-plan.md': 'Implementation Plan',
  'docLabel.02-verify-report.md': 'Verification Report',
  'docLabel.review-feedback.md': 'Review Feedback',

  'prompt.planModeVerify': `You are a **strict** test engineer. Verify the correctness of code changes.

## Issue Information
- IID: #{number}
- Title: {title}

## Idempotency Check (execute FIRST)
Before performing any action, check if a verification report already exists:
1. Read {planDir}/02-verify-report.md (if it exists)
2. If the report exists and its "Summary" section contains "Verification Passed", **stop immediately** — do NOT re-run any verification steps
3. If the report does not exist or the summary says "Verification Failed", proceed with the verification steps below

**Important**: This check prevents destructive re-execution (e.g. deleting test files that already passed).

## Pre-checks
Before running verification, confirm the dependency environment:
1. Check if {dependencyCheckPath} exists
2. If not, run {installCommand}; if that fails, try {installFallbackCommand}
3. If dependencies cannot be fully installed, mark as "environment issue" in the report and continue

## Verification Steps
1. Run {lintCommand} to check code style
2. Run {buildCommand} to check compilation
3. Run {testFilesCommand} to run relevant tests
4. Check code changes against {planDir}/01-plan.md implementation plan consistency
5. **Strictly check** if **all items** in {planDir}/01-plan.md Todolist are completed (- [x])

## Known Pre-existing Issues (can be ignored)
{knownIssuesSection}
- If a lint/build/test failure **does not involve files changed in this PR**, mark as "pre-existing issue"

## Verification Criteria (ALL must pass)
- Lint zero errors (related to current changes)
- Build successful
- All tests pass
- Todolist 100% complete (no unchecked items)
- Code matches implementation plan

Write verification results to {planDir}/02-verify-report.md, **must** include these sections:
- **Lint Results**: Pass/Fail + details (distinguish current changes vs pre-existing issues)
- **Build Results**: Pass/Fail + details (distinguish current changes vs pre-existing issues)
- **Test Results**: Pass/Fail + details
- **Todolist Check**: X/Y items completed + list of incomplete items
- **Plan Consistency Check**: Whether it matches the implementation plan
- **Summary**: Verification Passed/Verification Failed + specific reasons

**Important**: If any check fails, you MUST write "Verification Failed" in the "Summary" section.`,

  'prompt.plan': `You are a senior technical lead. Please complete requirements analysis and solution design in one go.

## Issue Information
- IID: #{number}
- Title: {title}
- Description:
{description}{supplement}

## Output Requirements
Please read the project's AGENTS.md first to understand the architecture, then proceed with analysis and design.

{outputInstruction}

### Part 1: Requirements Analysis
1. **Requirements Overview** — Summarize the requirements goal concisely
2. **Feature Breakdown** — List specific features to implement
3. **Impact Analysis** — Which modules/files may be affected
4. **Non-functional Requirements** — Performance, security, compatibility considerations
5. **Risks and Dependencies** — Potential risks and external dependencies

### Part 2: System Design
1. **Solution Overview** — Overall design approach
2. **Files and Modules Involved** — List of files to create/modify
3. **Data Model Changes** — Database or model layer changes
4. **API Design** — API interface definitions
5. **Detailed Implementation Steps** — Step-by-step implementation plan

### Part 3: Implementation Todolist
- [ ] Step 1: Specific description
- [ ] Step 2: Specific description
...

Ensure the Todolist is detailed enough that each step can be independently executed and verified.
{outputConstraint}`,

  'prompt.build': `You are a software engineer. Please complete code changes according to the implementation plan.

## Issue Information
- IID: #{number}
- Title: {title}

Please read first:
- {planDir}/01-plan.md (Complete implementation plan including requirements analysis, system design and Todolist)
- AGENTS.md (Project Architecture and Code Standards)

## Implementation Requirements
1. Strictly follow the Todolist in 01-plan.md, completing items one by one
2. After completing each item, update its checkbox status in 01-plan.md (- [ ] → - [x])
3. Strictly follow code standards in AGENTS.md ({codeStyleDescription})
4. Don't over-engineer, only implement what's required in the plan
5. Ensure code security, avoid OWASP Top 10 vulnerabilities`,

  'prompt.rePlan': `You are a senior technical lead. The previous implementation plan was not approved. Please modify the plan based on review feedback.

## Issue Information
- IID: #{number}
- Title: {title}
- Description:
{description}{supplement}

## Review Feedback History ({historyCount} rounds)
{feedbackLines}{rejectedPlanSection}

{rePlanReadInstruction}

## Output Requirements
{rePlanOutputInstruction}
Focus on the latest round of feedback while ensuring issues raised in previous rounds are also resolved.
{outputConstraint}`,

  'prompt.rePlanRound': '### Round {round} ({timestamp})\n{feedback}',

  'prompt.rePlanResume': `Your implementation plan submitted earlier in this conversation was not approved by review.

## Current Round Feedback
{latestFeedback}

## Full Review History ({historyCount} rounds)
{allRoundsLines}{supplement}

Please make substantive revisions to the plan you submitted earlier:
- For each feedback item, provide verifiable adjustments (what changed, why, scope of impact)
- Do not simply restate the previous plan or apply cosmetic edits
- Avoid empty slogans (e.g. "improve robustness"); use concrete designs/interfaces/steps/acceptance criteria

Please submit the complete revised implementation plan.`,

  'prompt.e2eSuffix.title': '## E2E UI Verification (Enabled)',
  'prompt.e2eSuffix.intro': 'E2E UI auto-verification is enabled for this change. Please perform the following additional steps:',
  'prompt.e2eSuffix.previewNote': '**Preview environment is running (managed by the system, no manual startup needed):**',
  'prompt.e2eSuffix.backend': 'Backend',
  'prompt.e2eSuffix.frontend': 'Frontend',

  // Conflict resolution
  'conflict.startComment': '🔧 **Merge Conflict Resolution Started**\n\nAttempting to rebase branch `{branch}` onto latest `{baseBranch}`...',
  'conflict.noConflictComment': '✅ **Rebase Successful, No Conflicts**\n\nBranch `{branch}` has been successfully rebased onto latest `{baseBranch}`, no conflict resolution needed.',
  'conflict.resolvedComment': '✅ **Merge Conflict Resolution Completed**\n\nBranch `{branch}` has been successfully rebased onto latest `{baseBranch}`, all conflicts have been automatically resolved and verified.',
  'conflict.failedComment': '❌ **Merge Conflict Resolution Failed**\n\n{error}\n\nRetry conflict resolution from the workbench.',
  'conflict.mrResolvedComment': '✅ **Merge conflicts have been automatically resolved**\n\nThe source branch of this PR has been successfully rebased onto the latest target branch, conflicts have been automatically resolved. Please re-review the changes.',
  'conflict.startedMsg': '🔧 Conflict resolution started, please wait...',
  'conflict.invalidState': 'Current state does not allow conflict resolution (current: {state}). Only allowed when Completed or after conflict resolution failure.',
  'conflict.noMr': 'Issue #{number} has no associated PR, cannot perform conflict resolution.',

  // Auto-update messages
  'update.checking': 'Checking for updates...',
  'update.available': 'New version available: v{latestVersion} (current: v{currentVersion})',
  'update.upToDate': 'Already up to date (v{currentVersion})',
  'update.draining': 'Waiting for active issues to complete...',
  'update.updating': 'Updating to v{version}...',
  'update.completed': 'Update completed, service will restart automatically',
  'update.failed': 'Update failed: {error}',

  'prompt.conflictResolve': `You are a senior software engineer handling merge conflicts during a Git rebase operation.

## Context
- Issue IID: #{number}
- Branch: \`{branch}\` is being rebased onto \`{baseBranch}\`
- Conflicting files:
{conflictFilesList}

## Task
Please resolve the conflicts in each file listed above:

1. Open each conflicting file and carefully read the conflict markers (<<<<<<< HEAD / ======= / >>>>>>> ...)
2. Understand the intent of both sides:
   - HEAD (current branch) changes
   - Incoming branch changes
3. Correctly merge the code, ensuring:
   - Meaningful changes from both sides are preserved
   - All conflict markers are completely removed (<<<<<<<, =======, >>>>>>>)
   - The merged code is logically complete, compilable, and runnable
4. If a conflict involves structural changes (e.g., function signature changes), ensure all references are updated accordingly

## Important
- Do not leave any conflict markers
- Do not introduce new bugs
- Maintain consistent code style
- Only modify conflicting files, do not make additional code changes`,

  // Distill (Knowledge Distillation)
  'distill.diaryCreated': '📝 Experience diary recorded for Issue #{number} ({outcome})',
  'distill.started': '🧪 Knowledge distillation started...',
  'distill.completed': '✅ Knowledge distillation complete — Memories: {memoryActions}, Rules: {ruleActions}, Vectors: {vectorIndexed}',
  'distill.failed': '❌ Knowledge distillation failed: {error}',
  'distill.runEmpty': 'No diary data available for distillation',
  'distill.noUndistilled': 'No undistilled diaries (minimum {threshold} required)',
  'distill.statusTitle': '📊 **Knowledge Distillation Status**',
  'distill.statusDiaries': 'Diaries: {total} (undistilled: {undistilled})',
  'distill.statusMemories': 'Memories: {count}',
  'distill.statusRules': 'Rules: {count}',
  'distill.statusVectors': 'Vector index: {count}',
  'distill.statusLastRun': 'Last distillation: {time}',
  'distill.statusNeverRun': 'Last distillation: never',
  'distill.triggerSuccess': '🧪 Knowledge distillation triggered, please wait...',

  // Build fix mode suffix (verify-fix loop)
  'prompt.buildFixSuffix': `

## \u26a0\ufe0f Fix Mode (Iteration {iteration})

**Important**: The previous verification found the following issues. Please fix them in this iteration:

{failures}

### Fix Requirements
1. Carefully read the specific error messages in the verification report
2. Fix all issues causing lint/build/test failures
3. Complete all incomplete Todolist items (- [ ] \u2192 - [x]), especially adding unit tests
4. Do not introduce new problems
5. After fixing, ensure {lintCommand} and {buildCommand} and {testFilesCommand} all pass

### Original Verification Report Summary
\`\`\`
{rawReport}
\`\`\`
`,

  // --- E2E Runner ---
  'e2e.runnerCreated': 'E2E verify phases will use dedicated AI runner ({mode})',
  'e2e.runnerFallback': 'E2E AI runner binary ({binary}) not installed, falling back to main runner',
};
