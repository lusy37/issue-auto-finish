# UAT 视觉复核最终实施方案

修订日期：2026-10-02（北京时间）。状态：已实施（代码与验证结果以仓库为准）。本文件替代此前的视觉复核方案，保留实施边界、契约和验收标准。

视觉证据缺口的自动修复、UAT 有限重试和 LangGraph 路由细节以
`docs/uat-visual-evidence-repair-plan.md` 为准。Build 异议只保存在服务端运行记录和阶段历史，前端不增加专门展示；Build 完成后继续沿
`build → verify → uat`，不新增直接的 `build → uat` 边。本文的状态矩阵和测试矩阵按该补充方案同步解释。

## 1. 目标与明确边界

在本次 Playwright 机器验收通过后增加截图视觉复核。机器证据、视觉观察和最终结论分别保存，由服务端组合判定；视觉 Agent 不能覆盖机器失败。

本期采用以下范围：

- 保留单用户、单实例、单仓库，以及 plan → review → build → verify → uat → 交付与经验采集流程。
- Verify 不执行 Playwright；机器 UAT 由服务端执行，视觉复核复用当前 Issue 注入的受控 AIRunner。
- 使用官方 `@openai/codex-sdk`、Managed Worker、全局 AI 额度、现有取消链和修复预算，不重建 CLI 参数或 JSONL 解析。
- 所有运行数据经统一路径解析器写入 `.iaf-mini/` 或显式配置的新数据目录，不使用原 `data/`，不把临时图片写进 Issue worktree。
- 不修改已批准的不可变计划，不新增发布、远程同步或第二套修复循环。本项目当前没有历史 UAT 数据，本期直接采用新契约，不实现旧格式兼容或迁移。

**读取范围的修正：本期保证输入材料受控，不承诺文件系统读取隔离。**

仅通过 `local_image` 附加本轮选定的截图；提示词提供原始需求、已批准计划中的验收要求及本轮截图清单。视觉工作目录只放送审图片，不附加源码、其他 Issue 数据或额外目录。

`workingDirectory`、`read-only` 和 `skipGitRepoCheck` 不等同于读取白名单。视觉调用关闭网页搜索并使用只读沙箱；只读沙箱仍可能允许模型执行只读命令，因此不能宣称工具执行已被设置项阻止。当前实现依赖 SDK 的只读、无网络策略和临时图片目录边界，不再通过 stream 事件名称猜测工具调用。用户级配置、规则等隐式上下文也不能由临时目录消除。

如果以后要求“进程只能读到指定图片”，应单独实现并验证操作系统或容器级读取边界；不能把本期功能标记为已满足该要求。只读沙箱及网页搜索权限分别配置，参考[官方说明](https://learn.chatgpt.com/docs/agent-approvals-security)。

## 2. 最终判定与状态矩阵

机器结果必须来自本次唯一运行目录、已等待结束的 Playwright 进程以及该进程产生的 JSON 报告：

```ts
machinePassed =
  !machineCancelled &&
  playwrightExitCode === 0 &&
  reportValid &&
  passedTests > 0 &&
  failedTests === 0 &&
  reportErrors.length === 0;

passed =
  status === 'completed' &&
  machinePassed &&
  (!policy.visualReviewEnabled || visualReview.status === 'passed');
```

其中 `failedTests = unexpected + flaky`，继续拒绝存在不稳定测试的报告。`reportValid` 必须校验实际读取的 JSON 形状、非负整数计数和 `errors` 数组，不能只检查文件存在。退出码、报告有效性、报告错误和机器结束时间单独保留，便于审计。

只有调用成功、输出契约有效、截图覆盖充分、目录清理完成时，服务端才允许视觉状态为 `passed`。这些条件失败时不留一个可供通过判定使用的 `passed` 状态。

| 机器结果 | 视觉结果 | 最终状态与结果 | 阶段动作 |
| --- | --- | --- | --- |
| 执行中 | `not-run` | `running / passed=false` | 等待机器结果 |
| 失败 | `not-run` | `completed / passed=false` | 沿用断言与环境错误分类 |
| 通过，视觉关闭 | `not-run`，注明关闭 | `completed / passed=true` | 允许生成 UAT 凭证 |
| 通过，视觉执行中或排队 | `pending` | `running / passed=false` | 等待视觉结果 |
| 通过 | `passed` | `completed / passed=true` | 允许生成 UAT 凭证 |
| 通过 | `failed`，包含 blocker/major | `completed / passed=false` | 修复开关开启且预算允许时回 Build，否则人工处理 |
| 通过 | `failed`，只有 minor | `completed / passed=false` | `hard-no-auto`，人工处理 |
| 通过 | `needs-review`（runtime timeout/environment/cleanup） | `completed / passed=false` | 在 `uatReviewRounds` 上限内沿 LangGraph `uat → uat` 重试 |
| 通过 | `needs-review`（结构化视觉缺口） | `completed / passed=false` | 按 `repairRounds` 回 Build，之后沿 `build → verify → uat` |
| 通过 | 其他 `needs-review` | `completed / passed=false` | `hard-no-auto`，人工处理 |
| 任意 | 用户暂停或取消 | `cancelled / passed=false` | 交给原有停止流程，不请求修复 |
| 任意 | 服务中断或执行身份失效 | `interrupted / passed=false` | 不签发凭证；恢复后重新运行 |

优先级为：停止或身份失效 → 执行及证据异常 → 覆盖不足 → 已确认视觉问题 → 通过。即使发现 major，如果同时存在无法判读的必需图片，也先进入 `needs-review`，保留问题但不自动修复。

`minor` 的人工处理指查看报告、修复代码并重新验收，或按现有流程显式调整配置后重新运行。不增加修改 JSON、手动把视觉状态改成通过或跳过当前失败结果的通道。

## 3. 数据模型与单一新契约

新增独立的 `UAT_FORMAT = 'iaf-mini/uat/v1'`。本项目当前没有历史 UAT 数据，因此所有 UAT 记录直接使用这一契约，不实现旧格式兼容、隐式迁移或历史记录分支。视觉输出契约校验失败直接使本轮视觉结果进入 `needs-review`，不尝试猜测字段含义。

```ts
type UatRunStatus = 'running' | 'completed' | 'cancelled' | 'interrupted';
type VisualReviewStatus = 'not-run' | 'pending' | 'passed' | 'failed' | 'needs-review';

interface ScreenshotEvidence {
  id: string;                 // 服务端生成的稳定图片 ID
  path: string;               // artifacts 根目录内的标准化相对路径
  sha256: string;
  testId: string;
  projectName: string;
  caseId: string;
  sceneId: string;
  viewport: { width: number; height: number };
  pageUrl: string;
  acceptanceRefs: string[];
}

interface VisualReviewIssue {
  screenshotId: string;
  caseId: string;
  sceneId: string;
  viewport: { width: number; height: number };
  severity: 'blocker' | 'major' | 'minor';
  screenshot: string;         // 原始运行目录内的受控相对路径
  description: string;
  expected: string;
  observed: string;
}

interface VisualReviewResult {
  status: VisualReviewStatus;
  summary: string;
  issues: VisualReviewIssue[];
  selectedScreenshots: string[];
  checkedScreenshots: string[];
  unreviewedScreenshots: string[];
  coverageGaps: string[];
  reasonCode?: string;
  requestedModel?: string;
  actualModel?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface UatPolicySnapshot {
  visualReviewEnabled: boolean;
  maxImages: number;
  model?: string;
  timeoutMs: number;
}

interface UatExecution {
  candidateCommit: string;
  planRevision: number;
  planDigest: string;
  buildGeneration: number;
  dispatchId: string;
  phaseAttemptNo: number;
  visualCallId?: string;
}

interface MachineUatResult {
  playwrightExitCode: number | null;
  machineCancelled: boolean;
  reportValid: boolean;
  reportErrors: string[];
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  screenshots: ScreenshotEvidence[];
  failureKind?: 'assertion' | 'environment';
  error?: string;
  machineFinishedAt: string;
}
```

新 `UatResult` 使用严格契约，保留现有 `runId`、`issueIid`、测试计数、截图链接和错误字段，并增加：

| 字段 | 规则 |
| --- | --- |
| `format` | 必须等于 `UAT_FORMAT` |
| `status` | 使用上面的运行状态；只有工件发布完成后才允许为 `completed` |
| `machinePassed` | 必填；初始值为 false，机器完成后由服务端计算 |
| `passed` | 必填；只按第 2 节计算 |
| `visualReview` | 必填；机器失败和视觉关闭分别记录 `not-run` 及原因 |
| `policy` | 在 UAT 开始时固化视觉开关、图片上限、模型和超时，不读取中途变化的配置重解释结果 |
| `execution` | 绑定候选提交、计划修订及摘要、构建轮次、dispatchId 和 UAT 阶段尝试编号 |
| `evidence` | 必须引用本轮 `screenshots.json`，所有图片 ID 均可反查到证据 |
| `machineFinishedAt` | 机器完成时间；与视觉完成时间分开 |
| `finishedAt` | 仅终态且所有必需工件发布完成后才有值 |
| `summaryDigest` | 对移除 `summaryDigest` 字段后的终态 summary 规范化 JSON 使用 SHA-256 计算，供交付凭证复核；文件缩进和换行不参与摘要 |

`failureKind` 只描述 Playwright 的 `assertion / environment`。视觉问题及操作异常通过 `visualReview.reasonCode` 表达；UAT 总错误可展示给用户，但不能反向修改机器结论。`summary.json` 是本轮唯一权威结果，`uat-run.json` 和 Markdown 只是展示副本。

共享类型只放类型和纯常量；Zod 校验放服务端模块，避免前端共享模块依赖 Node 或服务端执行逻辑。所有字段均按本节新契约校验，缺失、未知字段和跨字段不一致直接拒绝本轮结果。

## 4. 截图证据与验收场景

新增 `ScreenshotEvidence` 清单，记录第 3 节定义的完整字段。图片文件名只用于展示和排序，不作为场景识别依据；送审集合只从 `artifacts/` 原始截图生成，不扫描 HTML 报告资源。

验收条目的标识由服务端从不可变计划派生，例如 `plan:0`、`task:login:0`，并绑定计划摘要。补充需求中的验收文本也保留来源。派生清单是运行证据，不修改已批准计划。

Build 阶段增加视觉用例清单及截图采集辅助函数：

1. 用例清单明确场景、页面、必需视口及对应验收条目；必需项不能依靠 Agent 自行在运行后删除。
2. 测试在明确的页面状态调用采集函数，向本次 Playwright 报告附加截图及对应元数据；实际视口、页面地址从运行中的页面获取。
3. 服务端只接受本次 JSON 报告关联、实际存在于本轮 artifacts 目录中的文件，结合测试状态验证证据归属。
4. 同一图片在 HTML 报告中的复制文件不再次计入送审数量；具有不同场景或验收意义的相同画面不能因内容相同而丢失覆盖关系。
5. 既有配置存在时也必须检查并补齐视觉证据能力，不能沿用“仅缺少 Playwright 配置时才生成测试”的条件。

视觉用例清单由工作台按 Issue 保存到 `DATA_DIR/issues/<编号>/uat/visual-cases.json`，不属于业务仓库候选提交；Playwright 测试通过 `IAF_VISUAL_CASES_FILE` 读取当前清单，运行副本保存到本轮证据目录。清单格式固定如下：

```json
{
  "format": "iaf-mini/visual-cases/v1",
  "planDigest": "计划摘要",
  "cases": [
    {
      "id": "case-login-desktop",
      "sceneId": "login",
      "acceptanceRefs": ["task:login:0"],
      "viewports": [{ "width": 1440, "height": 900 }],
      "expectedState": "登录表单可见"
    }
  ]
}
```

每个 case 必须至少生成一张对应视口的原始截图；采集函数通过 Playwright attachment 写入 `caseId`、`sceneId`、视口、页面地址和验收引用，服务端据此生成 `ScreenshotEvidence`。重复 ID、未知验收引用、计划摘要不匹配或必需字段缺失时拒绝采用。未明确要求移动视口时不增加移动验收标准；业务没有适用的视觉场景时，必须显式关闭视觉复核后重跑。

场景清单由 Build 产生，因此仍可能与测试一起遗漏需求。视觉 Agent 必须同时获得完整原始验收要求，指出清单或证据中的缺口；服务端只能确定性校验关联和集合覆盖，不能宣称已通过文件名或自然语言关键词算法证明需求完整性。

没有足够元数据的截图只能作为原始证据保留，不能据此断言已覆盖某个必需场景。缺少视觉清单、必需场景未生成图片、必需视口未出现、全部图片无效或有效图片为零，均直接进入 `needs-review`。这些规则与是否超过图片上限无关。

## 5. 图片选择、路径检查和数量限制

确定性选择规则：

1. 先覆盖全部必需的“场景 × 视口”组合。
2. 对剩余可选图片按验收要求关联、首页或默认页、桌面布局、窄屏布局排序。
3. 同优先级按标准化相对路径字典序及稳定图片 ID 排序。
4. 必需覆盖本身已超过图片上限时，不截断后判通过，直接记录缺口并进入 `needs-review`；本期不新增自动分批调用。

图片提交前进行以下检查：

- 源文件通过 `realpath` 校验确实位于本轮 artifacts 根目录；拒绝绝对路径输入、`..` 越界、符号链接和 Windows junction 等逃逸路径，并在复制前后再次核对路径和摘要。
- 宿主确认文件可读、非空、图片格式有效；限制单文件与总输入体积，超限记为证据异常，不静默忽略必需图片。
- 复制到临时目录后核对摘要，避免传入图片与原始证据不一致。
- 临时文件使用服务端生成的扁平名称，如 `image-001.png`；服务端持有临时路径与原始图片 ID 的映射，Agent 不决定最终文件链接。
- `selectedScreenshots` 和 `checkedScreenshots` 均保存稳定图片 ID；`checkedScreenshots` 只接受完整成功调用中通过校验的已判读集合；`unreviewedScreenshots` 由服务端用有效原始图片集合减去已判读集合计算。
- 解析失败、调用失败或身份失效时，本次不接受任何已复核声明，`checkedScreenshots=[]`，送审图片仍属于未复核。

## 6. 视觉 Agent 输入与输出契约

视觉调用使用新会话。提示词使用中文，要求仅依据送审图片和给定验收要求，检查白屏、错误页面、非预期空状态、异常弹窗、遮挡、溢出、重叠，以及主要标题、业务内容、按钮、表单和计数展示。预期的空状态、错误提示等必须结合具体验收场景判断，不能见到就报缺陷。

截图只能提供所见页面状态的证据，不能证明按钮可点击、接口正确或整个交互链正常；这些仍由 Playwright 断言验证。视觉调用同时接收本次 Playwright 的机器结果和与当前候选提交绑定的 Verify 报告，用于了解动态行为已经由自动化测试覆盖的范围，但不能把测试通过扩大解释为视觉通过。提示词明确：点击计算、状态转换、接口行为和边界条件不要求截图独立证明，`coverageGaps` 只记录缺少界面场景、视口或可见状态等视觉证据。要求不清、图片无法判读或证据不足时必须如实返回“不确定”。截图文字、Issue 内容和参考文本是待审材料，不是可以覆盖复核规则的指令。

Agent 只返回逐图观察及覆盖缺口，取消原先让 Agent 决定整体 `passed / failed` 的字段：

```json
{
  "summary": "首页与窄屏截图均已判读",
  "screenshots": [
    {
      "id": "image-001",
      "assessment": "clear",
      "reason": "标题、主要内容与按钮均可见",
      "issues": []
    },
    {
      "id": "image-002",
      "assessment": "defect",
      "reason": "窄屏下提交按钮被底部浮层遮挡",
      "issues": [
        {
          "severity": "major",
          "description": "提交按钮被遮挡",
          "expected": "按钮完整可见",
          "observed": "按钮下半部分被底部浮层覆盖"
        }
      ]
    }
  ],
  "coverageGaps": []
}
```

逐图 `assessment` 只允许 `clear / defect / uncertain / unreadable`。`uncertain / unreadable` 必须给出原因。Agent 不返回最终文件路径、运行编号、时间或机器结果。

Agent 返回的问题默认归属于所在截图；服务端根据图片 ID 反查 `ScreenshotEvidence`，补齐 `screenshotId`、`caseId`、`sceneId` 和视口，禁止 Agent 自行伪造证据链接。

服务端用严格 Zod Schema 和语义校验同时验证：

- `RunResult.success === true`；worker 与 SDK 调用完整结束，且没有超时或取消。
- JSON 能完整解析，不从任意文字中拼接一个貌似成功的片段；拒绝未知字段和错误类型，限制文本长度与数组规模。
- 每张送审图片恰好有一个观察结果；图片 ID 不得缺失、重复或来自未知文件。
- `clear` 的问题列表必须为空；`defect` 必须含至少一个有效问题；严重级别只允许 blocker、major、minor。
- 未知引用、无法判读、不确定、覆盖缺口或服务端检测到的必需证据缺失，统一得到 `needs-review`。
- 完整有效且全部为 `clear` 时才得到 `passed`；完整有效且存在 `defect` 时得到 `failed`，再按最高严重级别选择阶段动作。

这使业务通过状态完全由服务端生成，也为“图片读取成功但不足以判断”提供明确表示。

## 7. Runner、SDK 与调用预算

视觉调用使用窄化后的用途类型和 JSON Schema；Schema 必须是可跨 IPC 序列化的普通对象，不能传 Zod 实例或函数。视觉调用的 `workDir` 指向本次临时图片目录，`CodexRunner` 根据固定用途在内部设置 SDK 的 Git 目录检查策略，公共 `RunOptions` 不暴露开关。

视觉用途通过集中调用策略构造：`mode='plan'`、`phaseName='uat'`、指定模型、新会话。SDK 线程设置 `sandboxMode='read-only'`、`approvalPolicy='never'`、`networkAccessEnabled=false`、`webSearchMode='disabled'`，不设置 `additionalDirectories`。Windows 保持当前 `elevated` 策略。

`CodexRunner` 按官方 SDK 的输入类型传图，并把输出约束放在 turn 选项中：

```ts
const input = [
  { type: 'text' as const, text: options.prompt },
  ...(options.imagePaths ?? []).map((filePath) => ({
    type: 'local_image' as const,
    path: filePath,
  })),
];

const { events } = await thread.runStreamed(input, {
  signal: controller.signal,
  outputSchema: options.outputSchema,
});
```

未附加图片的现有调用保持现有行为。Managed Worker 继续透传可序列化选项，不自行解析 Codex 协议。视觉 Runner 复用注入的 AIRunner、全局额度和进程树管理，不创建第二个 Managed Runner，也不调用全局 `killAll` 影响其他 Issue。

视觉超时默认 180000 毫秒，定义为图片准备、等待全局额度和模型执行的业务总预算。截止时间在图片准备前创建，并覆盖全局额度排队；达到截止时间后取消排队和 worker。退出进程和清理目录属于收尾阶段，必须继续等待且不重新占用业务预算。视觉调用关闭自动续时，避免实际执行超过配置预算。

当前 `ScopedRunner` 会覆盖调用方传入的 signal，需要改成父 Issue signal 与调用方 signal 的组合：父级取消必须始终生效，视觉局部超时也必须能取消排队与 worker。区分用户停止、局部超时和执行身份失效，分别采用第 2 节的状态处理；worker 退出确认后才允许清理临时目录。

SDK 适配器当前 `exitCode=0` 是成功映射，不是公开的 Codex 原始进程退出码。真实验证记录 SDK 流完整完成、适配器成功状态和 worker 退出情况；不能为了取得原始码另建 CLI 包装层。

## 8. 存储职责与原子发布

所有路径通过 `resolveDataDir()` 和现有 Issue 工件解析器生成，不把 `.iaf-mini/data` 写死。确保 UAT 存储、Issue 工件和恢复服务使用同一配置的数据根目录，不因 `PlanPersistence` 的显式 dataDir 与进程环境不同而分散写入。如果显式配置的数据根目录位于当前 Issue worktree 中，应报告配置错误，要求改用独立运行目录。新目录布局：

```text
<dataDir>/uat/<runId>/
  results.json               本次 Playwright 原始 JSON 报告
  command.log                本次机器执行日志
  artifacts/                 原始截图及测试附件
  report/                    HTML 报告
  machine.json               完整机器结果，完成后不被视觉结果覆盖
  screenshots.json           本轮证据清单及关联元数据
  visual.json                视觉结果，包含未执行或异常原因
  summary.json               本轮 UAT 权威摘要

<dataDir>/visual-review-tmp/<runId>/<uniqueAttempt>/
  image-001.png              仅送审图片

<dataDir>/issues/<issueIid>/artifacts/
  uat-run.json               当前 UAT 结果的展示副本
  03-uat-report.md           当前 UAT 中文报告
```

新增 `UatResultStore` 集中处理本轮工件和摘要，复用 `writeJsonAtomicSync / writeTextAtomicSync`。Issue 工件仍通过 `PlanPersistence` 写入，为其补充原子写能力。

把现有 `executeUat` 的职责收窄为机器执行和机器证据保存，返回 `MachineUatResult`；禁止它再把机器通过写成最终 `summary.passed=true`。协调层负责创建 runId、运行状态、视觉调用和最终判定。独立机器测试直接断言机器结果，不借用最终 UAT 类型。

发布顺序：

1. UAT 开始时在 Issue 聚合事务中登记当前 UAT runId 与执行身份，再原子写入 `running / passed=false` 的 summary，固化身份与配置快照。登记成功但 summary 尚未生成的崩溃窗口同样视为未完成运行。
2. Playwright 完成后保存 machine.json 和截图清单；机器通过且视觉开启时，summary 更新为 `machinePassed=true / passed=false / visualReview.pending`，然后才进入视觉调用。
3. 视觉结束或明确未执行后保存 visual.json，并在内存生成一致的终态结果与 Markdown。
4. 先原子更新 Issue 展示副本，再原子更新终态 summary；摘要的最后一次替换是本轮结果发布点。任何读取判定以 summary 为准，不能信任提前写好的展示副本。
5. 所有必需工件成功写入后由 `UatPhase` 发布展示副本和终态 `summary`；`DagPhaseRunner` 再次检查身份、候选提交、执行轮次与 `summaryDigest`，通过每 Issue 聚合事务签发 UAT 凭证。

多个文件不能靠连续写入获得整体事务。发布中断时，summary 保持待定或明确中断；展示副本由权威摘要重建。任何持久化错误都不得返回 `completed`，不得签发交付凭证。若磁盘无法写入中断状态，保留原待定记录并报告存储异常。

每次更新当前 Issue 展示副本及发布终态前都核对当前 runId、执行身份和停止标记，不能只依赖 AI 调用返回时的一次校验。其他运行的证据可以保留，但不得用其他 runId 重建当前 Issue 的展示副本。

终态报告保留为本次运行记录，不得用于新一次 UAT 的通过判定。summary 已完成但还没有聚合凭证的重启窗口，也不能通过读取文件自动补发成功凭证，应重新验收。已有聚合凭证的正常交付重试仍按现有流程核验，不重跑已完成的业务流程。

## 9. 生命周期、取消与恢复

临时目录由服务端登记：保存 Issue、runId、所属执行身份及目录归属，放在图片目录以外。登记和状态变化遵循每 Issue 聚合事务。增加专用的 `temporaryDirectories` 字段，条目包含 `kind='visual-review'`、runId、directory、执行身份和 createdAt；不把目录塞入现有只接受 Playwright wrapper 文件名的 `temporaryFiles`。当前 UAT 运行登记与临时目录登记分别保留，保证在机器执行期间、尚未创建视觉目录时发生崩溃也能恢复运行状态。

清理规则：

- 创建任何图片前先完成目录归属登记；失败时不启动 Agent。
- 正常返回、调用失败、解析异常、局部超时和用户取消均执行 finally，等待受控 worker 及进程树退出后再清理。
- Windows 对文件占用执行有限次数重试；删除失败保留登记和错误，视觉结果不得保持通过，转 `needs-review`。
- 重启时先核实旧调用已经退出，再按登记清理专用目录；归属不明或进程未确认退出时停止自动清理并进入人工处理。
- 递归删除前验证真实路径位于专用临时根目录、Issue/runId 匹配且不含链接逃逸；拒绝删除根目录、源截图、HTML 报告或任意 worktree。
- 清理完成后才删除登记；不得扫描并删除其他未登记业务目录。

用户暂停或取消时，不把取消异常包装成 major、普通环境失败或自动修复请求。尽力保存 `cancelled / passed=false` 后传播停止信号，由既有生命周期处理；用户继续时新建运行编号并重新执行机器 UAT。

服务重启后未结束的记录标记 `interrupted / passed=false`，保留原始证据。恢复清理本身不消耗修复轮次；重新执行按现有重试与人工继续规则计费，不新增预算。取消、重启或新一轮调度后的迟到结果不得覆盖当前 Issue 展示副本、推进阶段或签发凭证。

## 10. 编排接入与交付保护

`UatPhase` 保存注入的 AIRunner 并调用 `VisualReviewRunner`。`DagPhaseRunner` 为本次 UAT 提供只读的验收计划快照及候选提交身份；使用现有 scoped Runner 校验每次 AI 调用身份。

视觉失败包含 blocker/major，且修复开关开启时返回：

```ts
{
  kind: 'requestRetryFrom',
  targetPhaseId: 'build',
  reason: 'uat-visual-failed',
  context: {
    verifyFailures: visualFailures,
    rawReport: markdown,
  },
}
```

修复上下文必须包含场景、视口、严重级别、期望、观察、原始图片链接及本轮 runId。写入现有 `verifyFailures` 时使用服务端生成的完整中文条目，不能只传一段模型摘要。服务端按现有 `repairRounds / VERIFY_FIX_MAX_ITERATIONS` 扣除预算；修复后重新形成候选提交，执行 Verify 和全新 UAT。

视觉异常返回 `failed` 与 `retryable='hard-no-auto'`，使用 `visualReview.reasonCode='uat-visual-review-environment'` 等结构化原因。`PhaseError.message` 写中文说明，`rawOutput` 写报告；不往当前没有该字段的 FailedIntent 上直接添加 `reason`。

交付前增加结果契约核验：UAT 启用时，聚合凭证必须指向本轮新格式的终态 summary，summary 的候选提交、计划修订及摘要、构建轮次与凭证一致，最终 passed 为 true。`uat-run.json` 和 Markdown 只能用于展示，不能单独作为凭证。视觉是否启用以本轮 `policy` 快照为准；配置变更只对之后新建的 UAT 运行生效，不能在交付时重新解释当前运行。

现有 `AcceptanceReceipt` 保留 Verify 的字段；为 UAT 凭证增加必填的 `uatEvidence`，包含 UAT 格式号、计划修订及摘要、构建轮次、视觉开关快照和终态摘要的内容摘要。UAT 签发时写入，交付时重新读取并核验 summary；相应更新 Issue codec 与 invariant，而不是只在展示 JSON 中增加字段。

不因“当前 dispatchId 改变”否定合法的已完成交付重试：dispatchId 用于阻止执行期间的迟到写入，已完成凭证则核对其原执行身份与当前候选内容的一致性。

## 11. 配置、报告和前端

```env
E2E_VISUAL_REVIEW_ENABLED=true
E2E_VISUAL_REVIEW_MAX_IMAGES=12
E2E_VISUAL_REVIEW_MODEL=
E2E_VISUAL_REVIEW_TIMEOUT_MS=180000
```

- 开关严格接受 true/false，默认开启；总 E2E 开关关闭时，不创建 UAT 或视觉调用。视觉策略在 UAT 开始时复制到 `policy`，之后只使用这份快照。
- 图片上限为正整数，本期支持 1～12，默认 12；更多必需视图进入 needs-review，不静默截断。
- 模型为空时继承当前 AI 模型；模型不支持图片或无法执行时不能自动通过。记录请求模型，无法获知实际解析模型时不虚构模型名称。
- 超时为不小于 1000 毫秒的整数；含排队的预算语义必须出现在配置说明中。

同步修改配置 schema、配置转换、共享默认值、setup 路由白名单与默认值、CLI 初始化、env.example、测试配置工厂和设置页面。默认开启意味着首次执行 UAT 时必须生成完整视觉证据；业务没有适用场景时由用户显式关闭后重新运行。

报告和 `NativeVerificationPanel.vue` 展示：

- UAT 整体状态；机器通过、失败、跳过数量及机器错误。
- 视觉关闭、待定、通过、发现问题、需人工复核、取消或中断的明确文案。
- 送审、已复核和未复核数量；覆盖缺口与异常原因。
- 每个问题的截图、场景、视口、严重级别、描述、期望与观察。
- 本轮原始截图、HTML 报告和运行编号；不伪造视觉通过。

视觉待定不能显示 PASS；视觉关闭必须显示“机器通过，视觉复核未启用”。原有“仅机器结果决定全部验收”的文案同步调整。图片链接由服务端受控路径构造并对路径片段编码，Agent 文本按普通文本渲染。

UAT 运行列表继续使用 `src/web/routes/uat.ts`，增加新展示契约及输入校验，不新建重复接口。前端 client 类型按需调整；`src/web/routes/api.ts` 仅在系统状态确实要展示新增配置时扩展，不能误当作 UAT 列表入口。截图路径的每个片段必须编码，服务端只允许访问当前 runId 目录内的文件。

## 12. 文件改造清单

| 范围 | 新增或修改位置 | 工作内容 |
| --- | --- | --- |
| 共享契约 | `src/shared/workbench.ts`、`src/shared/runtime/formats.ts`、`src/shared/runtime/artifacts.ts` | 新结果格式、状态、视觉类型和产物元数据 |
| 机器执行 | `src/e2e/PlaywrightRunner.ts` | 独立机器结果、当前报告校验、证据清单、取消归属 |
| 视觉执行 | 新增 `src/e2e/VisualReviewRunner.ts` | 选图、复制、预算、调用、解析、清理 |
| 证据与存储 | 新增 `src/e2e/VisualEvidence.ts`、`src/e2e/UatResultStore.ts` | 场景覆盖、路径验证、结果校验与原子发布 |
| AI 协议 | `src/ai-runner/AIRunner.ts`、`CodexRunner.ts`、`ManagedCodexRunner.ts`、`sdk-worker.ts`、`CallPolicy.ts` | 图片、Schema、视觉用途策略及 IPC 验证 |
| 调用身份 | `src/dag/ScopedRunner.ts` | 合并父级与局部取消信号，保留身份保护 |
| 产物接口 | `src/persistence/PlanPersistence.ts` | Issue 展示副本原子写入 |
| UAT 接入 | `src/phases/UatPhase.ts`、`BasePhase.ts` 的上下文契约、`src/orchestrator/DagPhaseRunner.ts` | 本轮身份、验收要求、机器与视觉协调 |
| 测试准备 | `src/prompts/taskExecution.ts`、`DagPhaseRunner.ts` 的 Build 收尾 | 生成及验证视觉用例清单、截图采集能力 |
| 状态与恢复 | `src/orchestrator/IssueWorkflow.ts`、`src/orchestrator/IssueService.ts`、`src/tracker/IssueTracker.ts`、`src/dag/contracts.ts`、对应 codec/invariant | UAT 状态转换、临时目录登记恢复、修复回流和身份校验 |
| 交付保护 | `src/dag/DeliveryService.ts` | summary 摘要、候选提交、策略快照和 UAT 凭证一致性校验 |
| 配置 | `src/config-schema.ts`、`src/shared/runtime/defaults.ts`、`src/web/routes/setup.ts`、`src/cli/index.ts`、`env.example` | 配置读取、编辑、初始化与默认值 |
| API 与界面 | `src/web/routes/uat.ts`、`src/web/frontend/src/components/NativeVerificationPanel.vue`、`NativeWorkspacePage.vue`、前端 API/types | 运行状态、证据、问题与配置展示 |
| 测试与文档 | `tests/helpers/mock-factories.ts`、相关单元/集成/契约/前端测试、产物与验收说明 | 回归覆盖及真实验证记录 |

本项目没有历史 UAT 运行记录，实施时直接切换到上述新格式。新增字段必须同步更新 codec、invariant、API 类型和测试工厂，不保留旧格式分支或后备读取。

## 13. 实施顺序

1. **契约冻结与结果发布。** 完成新 UAT 类型、summary 状态、策略快照、证据关联和 `UatResultStore` 发布流程，用模拟视觉结果证明不会提前通过。
2. **截图证据。** 完成 Build 准备、截图元数据、场景与视口覆盖、路径检查和确定性选图，验证零截图与必需缺口。
3. **受控 SDK 通道。** 实现图片输入、输出 Schema、视觉策略、IPC 传递及局部取消信号，验证其他 AI 调用行为不变。
4. **视觉业务与编排。** 实现逐图契约、服务端聚合、阶段失败分类、修复回流和交付校验。
5. **恢复、界面及配置。** 完成临时目录清理、重启处理、配置入口、报告与界面。
6. **完整回归与真实验证。** 先完成模拟及工程检查，再分别记录真实 Playwright、真实 Codex 的验证，不用真实调用替代状态转换测试。

每步围绕行为测试实施；只补与本次风险相关的测试，不用逐行映射实现的断言凑覆盖率。

## 14. 测试矩阵

| 类别 | 必须覆盖的行为 |
| --- | --- |
| 机器依据 | 非零退出、无效 JSON、报告 errors、flaky、零测试、全跳过、机器超时、非本轮报告、机器失败时视觉零调用 |
| 视觉入口 | 开关关闭、开启且机器通过、有效图片为零、既有配置缺少采集能力、模型不可用 |
| 证据覆盖 | 必需场景缺失、必需视口缺失、未超上限但覆盖不足、必需项超限、确定性排序、HTML 副本不重复计数 |
| 图片与路径 | 不可读、空文件、损坏格式、体积超限、复制失败、摘要不符、路径越界、符号链接/junction、中文空格路径 |
| 输出边界 | 合法 clear/defect、uncertain/unreadable、非法 JSON、未知字段、重复/未知/缺失 ID、clear 带问题、defect 无问题、非法严重级别 |
| 调用失败 | `success=false` 但 output 含合法成功 JSON、SDK 完成后失败、worker 非零退出、局部超时、排队超时、禁止的工具行为 |
| 状态与存储 | 机器通过后接口仍待定、三类工件一致、原子写故障、展示副本写入失败、summary 发布前后崩溃、不签发未发布凭证 |
| 修复预算 | blocker/major 回 Build、结构化视觉缺口回 Build、runtime 视觉重试独立使用 `uatReviewRounds`、minor 和其他 needs-review 人工处理、开关关闭、额度耗尽 |
| 停止与恢复 | 排队/执行/发布前取消、父级和局部 signal 均生效、等待进程树退出、正常/异常清理、清理重试失败、重启登记恢复、迟到结果拒绝 |
| 候选与交付 | 验收期间 HEAD 或工作区变化、summary 摘要不匹配、执行身份不匹配、策略快照不匹配、合法交付重试 |
| SDK 契约 | local_image、turn outputSchema、视觉用途内部 Git 检查策略、IPC 透传、只读/搜索关闭/Windows elevated、新会话、普通文本调用回归 |
| API 与界面 | pending 非 PASS、关闭提示、问题与覆盖缺口、有效截图链接、设置保存与默认值 |

验证命令分两步执行，完整套件通过后不无理由重复同一批测试：

```powershell
# 开发期间执行相关测试；新增文件名按实施结果落实
npm test -- tests/unit/visual-review-runner.test.ts tests/unit/uat-repair.test.ts tests/unit/codex-runner.test.ts tests/unit/managed-sdk-worker.test.ts --maxWorkers=1 --minWorkers=1
npm run test:integration -- tests/integration/uat-project-runtime.test.ts tests/integration/uat-results.test.ts

# 交付前执行完整保留测试集与前后端构建
npm run typecheck
npm run lint
npm test -- --maxWorkers=1 --minWorkers=1
npm run test:e2e
npm run build
npm run web:build
```

`npm test` 包含的 Windows 进程测试必须在 Windows 实机实际运行；跳过不能报告为通过。真实浏览器未安装或真实模型不可用时，分别记录未验证项，不能用模拟结果填补。

真实验证分组：

- **A：真实 Playwright。** 在独立测试项目中验证当前退出码、报告、明确页面状态截图及场景/视口元数据；AI 与平台可模拟。
- **B：模拟 AIRunner。** 覆盖完整判定矩阵、预算、持久化故障、取消、恢复和交付保护；不得访问真实平台或模型。
- **C：真实 Codex。** 独立验证图片输入、逐图 JSON、启动失败诊断、超时/取消、只读策略、worker 收尾与目录清理。保存调用范围及证据，不把适配器成功映射冒充原始 Codex 退出码。

本功能验收不需要创建真实 GitHub Issue、发送评论、推送或创建 PR；相关流程回归使用模拟平台。真实外部写入若另有专门验证需求，应按该任务授权范围执行。

## 15. 最终验收条件

- 本次 Playwright 失败时视觉调用次数为零；只有本次退出码和有效报告可以建立机器通过事实。
- 视觉开启时，机器通过、视觉有效通过且本轮工件发布完成后才能签发成功凭证；复核期间始终待定。
- 零图片、场景/视口缺失、不可判读、执行失败、非法输出、超时和清理失败均不能通过。
- Agent 仅提供观察，最终状态、文件路径、覆盖集合及修复决策均由服务端生成。
- 输入图片只来自本轮送审清单；工作目录只含复制图片；不宣称具备未实现的文件系统读取隔离。
- 正常和异常返回清理临时目录，崩溃后按登记恢复清理；原始截图、报告和机器/视觉结果持续可访问。
- 只有本轮 `summary.json` 能参与 UAT 判定，格式、机器结果和视觉结果均由服务端校验并保持独立。
- blocker/major 仅在既有开关和预算允许时自动修复；minor 与证据异常进入人工处理。
- 取消、身份校验、进程树管理、候选提交验证、Build/Verify/Deliver 和交付重试保持有效。
- 不覆盖当前工作区已有改动，不引入固定复制 codex-home 的逻辑，不修改原 data 目录。
- 类型检查、相关测试、完整保留测试集、前后端构建完成；模拟验证与真实验证分别报告。

## 16. 本次实施记录

- 已落地新格式、机器验收与视觉复核 Runner、证据清单、原子摘要发布、执行身份、临时目录登记恢复、交付凭证校验、配置入口、API 和前端展示。
- 已通过 `npm run typecheck`、`npm run lint`、`npm run build`、`npm run web:build`，以及视觉 Runner、UAT 结果、UAT 修复入口、配置阶段循环、DAG 交付和项目 Playwright 运行时相关测试。
- 最近一次完整 `npm test -- --maxWorkers=1 --minWorkers=1` 记录为 107 个测试文件、872 个用例通过；随后已修正一个机器结果契约测试夹具并单独通过。剩余未通过项是本机缺少 Playwright Chromium，以及 Windows `cmd` 后代进程清理的超时/文件占用环境问题，未将其记为本功能通过。
- `npm run test:e2e -- --maxWorkers=1 --minWorkers=1` 已实际执行，因本机缺少 Playwright Chromium 可执行文件失败；真实浏览器验收仍待安装浏览器后单独验证。
- 当前没有历史 UAT 数据，因此没有增加旧摘要读取、旧字段映射或迁移逻辑；测试夹具直接使用 `iaf-mini/uat/v1` 新契约。
