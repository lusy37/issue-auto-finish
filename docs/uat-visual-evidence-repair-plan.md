# UAT 视觉证据争议与自动修复落地计划

修订日期：2026-10-03。本文只描述当前产品的新实现，不兼容旧 UAT 数据，不增加历史数据迁移或多格式读取分支。

本文只扩展 UAT 视觉证据的自动复核与修复路由。现有视觉采集、机器验收、候选提交和交付凭证规则继续有效；与
`docs/uat-visual-review-plan.md` 中“`needs-review` 和 minor 直接人工处理”“视觉问题与 Verify 共用
`repairRounds`”冲突的部分，以本文为准，实施完成后应同步修订旧方案的状态矩阵。Build 异议保存在服务端运行记录和阶段历史中，前端展示不属于本次范围。

## 目标

UAT 的机器结果、视觉结果和自动修复职责分开：

- Playwright 的退出码、有效报告和测试计数仍由服务端判定，模型不能改写机器通过事实。
- 截图只验证界面可见状态，例如布局、样式、文本、反馈、控件状态和遮挡。
- 动态行为和不可从静态画面独立确认的状态由 Playwright、单元测试和集成测试验证；具体采用哪种测试由验收条目的实际语义决定。
- 视觉 Agent 发现缺口后，不直接交人工；先允许 UAT 重试，必要时进入 Build 处理。
- Build 可以对视觉缺口提出异议，但异议必须引用当前候选提交上的测试证据，不能用自然语言直接覆盖 UAT 结论。
- 可自动恢复的问题在对应循环达到上限后才进入人工处理；取消、身份失效、机器验收失败或无法确认归属的问题沿用现有立即人工处理语义。

## 当前问题

当前 `UatPhase` 对 `needs-review` 直接返回 `hard-no-auto`，因此“缺少某个交互状态或可见状态证据”会立即显示为人工处理。现有编排器只允许 Verify/UAT 回退到 Build，且所有回退共用 `repairRounds`。当前 LangGraph 已有 `uat → build` 和 `build → verify → uat`，缺少的是 UAT 内部的有限重试；Build 阶段也没有视觉决定的解析和无变更完成语义。

这个行为需要改成分层处理：

1. 视觉 Agent 调用失败、超时或偶发无法判读时，在 UAT 内重试。
2. 缺少视觉场景、视口或截图采集时，回 Build。
3. Build 认为某个缺口实际上属于动态行为时，可以用 Playwright 测试反驳，验证通过后回到 UAT，不修改业务代码。
4. Build 判断确实缺少截图或存在界面缺陷时，补充 Playwright 证据或修复代码，然后重新 Verify 和 UAT。

以下情况不进入视觉自动循环：用户取消、执行身份失效、Playwright 机器失败，以及服务端无法确认候选提交或报告归属。这些情况沿用现有停止或人工处理语义。

## 具体判定规则

| 情况 | 自动动作 | 是否修改代码 |
| --- | --- | --- |
| Playwright 机器失败 | 保持失败，不调用视觉 Agent | 否 |
| 视觉 Agent 超时、调用异常、临时目录清理失败 | UAT 重试 | 否 |
| 图片不可读、模型未逐图返回、视觉清单缺失或必需场景/视口缺失 | 回 Build 处理视觉证据 | 通常修改测试或清单 |
| 缺口经判定属于行为证据，且已有可追溯的通过测试 | Build 可提出 `behavior-covered` 异议 | 否，引用已通过测试 |
| 验收明确要求某个可见状态，但没有对应截图 | Build 补充该状态下的 Playwright 截图采集 | 修改测试或清单 |
| 截图显示实际 UI 缺陷 | Build 修复业务代码 | 是 |
| 只有 minor 视觉问题 | 自动修复开关开启且 Build 预算未耗尽时进入 Build，否则人工处理 | 是或补充证据 |
| 任一自动循环达到上限 | 人工处理 | 由人工决定 |

所有验收都先区分“行为证据”和“视觉证据”，不把某一种交互状态写成固定规则：

- 行为证据回答“操作是否发生、状态是否正确、边界是否符合预期”，由 Playwright、单元测试或集成测试证明。凡是需要操作、时间顺序、内部状态、接口结果或边界条件才能确认的要求，不能只靠静态截图证明。
- 视觉证据回答“用户是否看到了正确的界面状态”，由对应状态下的截图证明。通过行为测试不能替代对布局、文本、颜色、遮挡、空状态或错误提示的视觉检查。
- 同一验收项可以同时需要两类证据。例如“按 Tab 后按钮获得焦点”需要 `page.keyboard.press('Tab')` 和 `expect(locator).toBeFocused()`；“获得焦点时显示明显焦点环”还需要在聚焦状态下采集截图。这里的键盘焦点只是示例，其他交互状态按同一原则判断。
- 例如，悬停是否触发菜单、点击后计数是否正确、请求是否完成属于行为证据；菜单展开后的布局、计数器是否被截断、完成后的空状态属于视觉证据。实际分类以验收文本和可观察结果为准，不按控件类型预设。

## 新增的最小结构化结果

视觉 Agent 仍然只返回逐图观察和覆盖缺口。为保持现有前端展示契约，`coverageGaps` 继续保存缺口描述字符串；服务端同时写入
`coverageGapDetails` 作为自动修复使用的结构化对象，不能只返回无法定位的自由文本。`kind` 只允许
`missing-case`、`missing-viewport`、`missing-visible-state`、`unreadable-image` 和
`incomplete-agent-output`：

```json
{
  "description": "计数完成后的空状态没有截图",
  "kind": "missing-visible-state",
  "acceptanceRefs": ["task:counter:1"],
  "caseId": "counter-complete",
  "sceneId": "completed",
  "viewport": { "width": 1440, "height": 900 },
  "screenshotIds": []
}
```

服务端校验验收引用、场景、视口和截图 ID 后，按本轮 `runId` 内的规范化排序生成从 0 开始且不重复的 `gapIndex`。`gapIndex` 只在该 `runId` 内稳定，跨 UAT 重试必须同时携带 `sourceRunId`，不能只凭数字匹配缺口。一次 Build 处理只绑定一个 `gapIndex`；同一 UAT 结果有多个缺口时，按 `gapIndex` 顺序逐轮处理，未处理缺口在下一轮 UAT 中重新生成和校验。

Build 处理视觉缺口时返回新的严格 JSON：

```json
{
  "schemaVersion": "iaf-mini/visual-repair/v1",
  "decision": "behavior-covered",
  "sourceRunId": "当前视觉报告的 runId",
  "candidateCommit": "当前候选提交",
  "planRevision": 3,
  "planDigest": "当前计划摘要",
  "buildGeneration": 2,
  "gapIndex": 0,
  "reason": "该条验收要求需要操作后的行为结果，不能由静态截图独立证明",
  "testRefs": [{ "path": "tests/e2e/keyboard-focus.spec.ts", "line": 18, "testId": "focus-ring", "acceptanceRefs": ["task:counter:1"], "reportDigest": "本轮 Playwright 报告摘要" }],
  "changedFiles": []
}
```

`decision` 只允许四种值：

- `behavior-covered`：现有测试已经证明该要求属于行为证据，不需要视觉截图。
- `add-visual-evidence`：验收要求某个明确的可见状态，但缺少该状态下的截图。
- `fix-ui`：截图显示界面实现本身有问题。
- `retry-visual`：当前图片或视觉调用无法判断，建议 UAT 重新复核。

服务端只接受身份字段与当前运行完全匹配的结果。`testRefs` 必须能在当前候选提交的文件内容和本轮 Playwright 报告中同时定位；服务端校验路径、行号、测试 ID、报告摘要、通过状态以及 `acceptanceRefs` 是否覆盖当前缺口，不能只校验字符串格式。Verify 报告只能作为上下文，不能单独证明测试已通过。`reason` 只是展示信息，不能成为通过依据。`changedFiles` 只用于展示，工作区是否变化由服务端独立读取 Git 状态。

`behavior-covered` 必须携带至少一个通过校验的 `testRef`，并覆盖该缺口的全部验收引用；`add-visual-evidence`、`fix-ui` 和 `retry-visual` 的 `testRefs` 允许为空。`retry-visual` 只能在工作区无变更时成立，完成 Build 后仍沿现有 `build → verify → uat` 链路重新复核。

## 循环与计数

增加一个独立的 UAT 配置和运行计数：

```text
E2E_VISUAL_REVIEW_MAX_RETRIES=2
```

默认允许两次 UAT 视觉重试。该计数属于当前 `planRevision + buildGeneration + repairRounds + candidateCommit` 的 Build 处理周期；进入新的 `uat → build` 处理周期或产生新候选提交后重置为 0，同一周期重启服务不重置。运行记录保存：

```text
run.uatReviewRounds
summary.visualReview.reviewRound
summary.visualReview.maxReviewRounds
```

现有 `VERIFY_FIX_MAX_ITERATIONS` 继续只限制进入 Build 的集成或视觉处理轮次，`MAX_RETRIES` 只限制阶段异常重试。三种计数互不消耗：

- UAT 视觉重试：只重新执行本轮 Playwright 和视觉复核，不产生提交，也不消耗 `MAX_RETRIES` 或 `repairRounds`。
- Build 处理：进入一次视觉或集成 Build 处理就递增一次 `repairRounds`；若修改测试或业务代码则形成新候选提交，若返回 `behavior-covered` 则不产生新提交。两种结果都沿现有 Verify 和 UAT 链路继续，并重置当前候选的 UAT 视觉重试计数。
- `behavior-covered`：不产生代码提交，但沿现有 `build → verify → uat` 链路重新生成 Verify 和 UAT 凭证；该次 `uat → build` 仍按现有集成修复轮次计数，不新增另一套 Build→UAT 预算。

UAT 视觉重试计数和下一阶段路由必须在同一 Issue 事务中落盘，保证在“递增计数后进程崩溃”的窗口恢复时不会重复扣减。达到 UAT 重试上限后，如果缺口仍然需要修改测试或代码，转 Build；达到 Build 修复上限后才转人工。取消、身份失效和机器失败不等待预算耗尽，直接沿用人工处理语义。

## 阶段流转

### UAT 阶段

`UatPhase` 在机器通过后执行视觉复核：

1. `passed`：生成成功凭证，进入交付。
2. `failed` 且存在 blocker/major：请求回 Build，沿用集成修复预算。
3. `needs-review` 且原因是 timeout、environment 或 cleanup：若 `uatReviewRounds < max`，递增 UAT 计数并重新执行 UAT。
4. `needs-review` 且包含图片不可读、逐图结果缺失、视觉清单缺失或必需场景/视口缺口：进入视觉证据处理分支，携带当前 runId、gapIndex、截图 ID、场景、视口和验收引用。
5. `failed` 但只有 minor：按自动修复开关和 Build 预算决定是否回 Build；不得直接签发通过凭证。

视觉复核重试使用新 runId，不能复用旧的截图、报告或视觉结果。机器结果和视觉结果仍分别保存。

视觉重试使用 LangGraph 的显式回边，不在 `UatPhase.run()` 内部使用 `while` 循环：

1. 每次 `UatPhase.run()` 只执行一轮 Playwright 和视觉复核，创建一个新的 `runId` 并发布本轮摘要。
2. 满足 runtime 重试条件时返回结构化的“重试当前阶段”意图；该意图不能伪装成 `requestRetryFrom(build)`，也不写入集成修复记录。
3. `IssueWorkflow` 在同一 Issue 事务中校验当前候选提交、`buildGeneration`、计数上限和执行身份，递增 `uatReviewRounds` 后将图路由回 `uat`。图节点需要显式允许 `uat → uat`，但不能配置成无条件自循环。
4. 回边使用新的 LangGraph 检查点和新的阶段操作编号，因此每轮都能恢复、取消、审计，并拒绝旧 run 的迟到结果。视觉重试不使用 LangGraph 通用 `retryPolicy`，避免消耗 `MAX_RETRIES`。

用户取消、父级 signal、执行身份失效和重启恢复都必须拒绝迟到的旧 run 结果。

### Build 阶段

Build 只接收本轮视觉报告和已批准计划中的相关验收要求。提示词必须明确：

- 只处理当前视觉缺口，不做无关重构。
- 可以检查和修改 Playwright 测试、工作台运行目录中的视觉用例清单和必要的 UI 实现；不得把 Issue 绑定的视觉清单写入业务仓库。
- 动态行为使用 Playwright 断言，不为每条动态行为强行添加截图。
- 如果行为已经由当前候选提交的测试证明，返回 `behavior-covered`，不要修改文件。
- 如果返回 `behavior-covered`，`changedFiles` 必须为空；如果工作区产生变更，服务端按普通修复处理，不采纳该异议。

Build 处理前后由服务端记录候选提交和工作区状态。只有前后 HEAD、工作区状态和 `changedFiles` 均表明无变更时，才允许 `behavior-covered`；否则将其降级为普通 Build 修复结果。

Build 处理结果分两路：

- `behavior-covered`：不提交新代码，Build 阶段完成后沿现有 `build → verify → uat` 链路继续；Verify 重新确认当前候选提交，再由 UAT 重新执行机器和视觉验收。
- `add-visual-evidence` 或 `fix-ui`：提交修改后的候选版本，重新执行 Verify，再执行全新 UAT。

因此不需要新增直接的 `build → uat` 边。只需新增 `uat → uat` 的有限重试，并保留现有 `uat → build` 视觉修复回流；所有 Build 结果统一沿 `build → verify → uat` 继续。`behavior-covered` 的特殊性只体现在“不产生代码提交”，不能跳过 Verify，也不能让旧 Verify 凭证直接替代本轮 Verify。

## 提示词边界

视觉 Agent 提示词：

- 只看图片、视觉用例和验收文本。
- 可以读取本次 Playwright 计数和 Verify 报告作为上下文。
- 不要求截图独立证明需要操作、时间顺序、内部状态、接口结果或边界条件才能确认的行为。
- `coverageGaps` 只描述缺少界面场景、视口或可见状态；模型返回结构化缺口后由服务端生成展示用字符串，并校验必需的场景、视口、截图 ID 和验收引用。

Build 视觉修复提示词：

- 只围绕 Playwright 证据和明确的 UI 缺陷处理。
- 必须在 `behavior-covered` 时给出可追溯测试引用，并覆盖该缺口的所有 `acceptanceRefs`。
- 不接受“截图证明不了，所以默认通过”这一结论；只能说明该要求属于行为验收，并由测试证明。
- 不允许修改验收结果文件、手动设置视觉状态或跳过 UAT。

## 代码改动范围

按以下顺序实现，避免同时改动无关模块：

1. `src/shared/workbench.ts`、`src/orchestration/PhaseResult.ts`、`src/orchestration/PhaseHistory.ts`
   - 增加结构化视觉缺口、Build 决定和视觉重试意图。
   - 为阶段历史保留 `sourceRunId`、`gapIndex`、决定和测试引用。

2. `src/e2e/VisualReviewRunner.ts`、`src/e2e/VisualEvidence.ts`、`src/e2e/UatResultStore.ts`
   - 输出并校验结构化视觉缺口，生成本轮稳定 `gapIndex`；保留 `coverageGaps` 字符串用于既有展示，自动修复只读取 `coverageGapDetails`。
   - 保存 UAT 专用轮次、复核原因和新的结构化决定。
   - 直接采用新契约；不写旧字段映射和迁移逻辑。

3. `src/dag/contracts.ts`、`src/dag/codecs/IssueRunCodec.ts`、`src/dag/IssueRunStore.ts`、`src/dag/invariants.ts`
   - 保存 `uatReviewRounds`、视觉修复上下文和身份绑定。
   - 新计划、新候选提交和新构建轮次按规则重置计数，恢复时拒绝过期上下文。

4. `src/config-schema.ts`、`src/shared/runtime/defaults.ts`、`src/config.ts`、`src/web/routes/setup.ts`、`env.example`
   - 增加 `E2E_VISUAL_REVIEW_MAX_RETRIES`，接入默认值、配置读取、设置保存和配置测试。

5. `src/phases/UatPhase.ts`
   - 将 runtime 类 `needs-review` 转为有限 UAT 重试。
   - 将视觉证据缺口转换为 Build 修复意图。
   - 对 `behavior-covered`、`retry-visual` 的 Build 结果沿现有 Verify → UAT 链路继续。

6. `src/orchestrator/IssueWorkflow.ts`、`src/orchestrator/DagPhaseRunner.ts`、`src/orchestrator/inspectWorkflow.ts`、`src/orchestration/WorkflowState.ts`
   - 增加由结构化意图触发的 `uat → uat` 有限回边，禁止在 `UatPhase` 内部使用循环。
   - 保留并细化现有 `uat → build` 回流。
   - 保持 Build 完成后的既有 `build → verify → uat` 正向链路，不新增直接 `build → uat` 边。
   - 保留候选提交、Verify 凭证和工作区干净检查。
   - Build 修改文件时仍必须重新提交并经过 Verify。

7. `src/prompts/taskExecution.ts` 与 Build 相关提示词
   - 增加视觉缺口专用提示词和严格 JSON Schema。
   - 将动态行为、视觉状态和可追溯测试引用写入规则。

## 测试计划

新增或调整以下测试：

1. 视觉结果解析：`behavior-covered` 不需要截图，`add-visual-evidence` 和 `fix-ui` 必须携带 gapIndex。
2. UAT runtime 异常会重试，达到 `E2E_VISUAL_REVIEW_MAX_RETRIES` 后才失败。
3. 对属于行为证据的视觉缺口，Build 返回 `behavior-covered` 并引用通过的相关测试，编排器沿现有链路重新 Verify 后回 UAT。
4. 对明确要求可见状态的缺口，Build 返回 `add-visual-evidence`，补充对应状态的 Playwright 截图后重新 Verify 和 UAT。
5. 截图显示真实 UI 缺陷时，Build 返回 `fix-ui`，必须生成新候选提交。
6. Build 返回 `behavior-covered` 但工作区有变更时，不采纳无变更结论，按普通 Build 修复处理。
7. UAT 和 Build 计数独立，任一达到上限都进入正确的下一状态。
8. 机器 Playwright 失败时不调用视觉 Agent，也不进入视觉修复循环。
9. 当前候选提交、计划摘要、Verify 凭证、UAT runId 或 BuildGeneration 不匹配时，结果无效。
10. 服务重启、取消、旧 run 迟到、计数递增后崩溃和临时目录登记恢复时，不重复扣减、不签发旧凭证。
11. `testRefs` 必须能由当前候选提交和本轮 Playwright 报告确定性校验，不能只依赖 Verify 自然语言报告。

## 验收标准

以“计数器页面”为例（仅说明判定方法，不限制其他页面）：

- 操作结果、状态变化和边界行为由 Playwright/单元/集成测试证明，视觉 Agent 不再要求每个动态结果都提供截图。
- 如果验收要求属于行为结果，Build 可以引用对应的通过测试反驳截图缺口，系统回 UAT 继续检查其他视觉内容。
- 如果验收要求明确描述可见状态，Build 必须补充该状态下的截图；行为测试不能替代视觉证据。
- 如果截图中确实存在遮挡、布局溢出或错误样式，必须回 Build 修复，不能通过异议绕过。
- 可自动恢复的运行异常和视觉缺口在达到各自上限前自动继续；取消、身份失效、Playwright 机器失败和无法确认候选归属时立即进入现有人工处理语义。
- `behavior-covered` 不产生候选代码变更，但必须沿现有链路重新 Verify、重新执行 UAT 并获得新的有效 UAT 凭证；该次 `uat → build` 遵循现有 Build 修复预算。

## 实施顺序

先完成结构化决定、缺口身份和三类计数，再实现 UAT runtime 重试；随后实现现有 `uat → build` 回流的视觉缺口协议，最后补充真实视觉回归。Build 完成后继续使用既有 `build → verify → uat` 链路，前端不作为本次验收范围。每一步通过对应单元/集成测试后再进入下一步。

交付前运行：

```text
npm run typecheck
npm run lint
npm test -- --maxWorkers=1 --minWorkers=1
npm run build
npm run web:build
```

真实浏览器验收与模拟平台验证分开报告；本机缺少 Chromium 时只报告环境阻塞，不把模型文字声明当作 UAT 通过依据。
