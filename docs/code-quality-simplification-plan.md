# 代码质量与过度防御性编程收敛计划

## 1. 目标

本计划针对最近 4 天的提交和当前工作区改动，目标是把补丁式修复收敛为容易学习、容易调试的结构：

- 保留真实业务边界：进程生命周期、取消、原子持久化、当前提交与当前 UAT 报告一致性。
- 删除只针对理论极端情况的重复检查、隐式 fallback 和重复状态副本。
- 让每个模块只承担一个主要职责，避免阶段代码同时执行、持久化、重试和交付校验。
- 不改变单用户、单实例、单仓库和现有 plan → review → build → verify → uat → deliver 流程。

本计划把当前工作区改动视为待审查材料，不把它们视为必须保留；实施阶段可以删除、合并或重写补丁式代码，也不引入旧格式迁移。

## 1.1 代码规范硬门槛

最近新增代码中出现了文件级 `eslint-disable`，例如同时关闭 `max-len` 和 `@typescript-eslint/no-explicit-any`。这会让 lint 表面通过，却把阅读和类型维护成本转移给后续开发者。重构阶段采用以下规则：

- 不允许新增文件级 `eslint-disable`。
- 现有文件级禁用必须逐个消除；长表达式通过拆函数、命名中间值和提取常量解决。
- `any` 改为领域类型、`unknown` 加小型类型守卫，或为外部数据定义明确的输入类型。
- 如果某一行确实需要例外，只允许行级禁用，并在同一行附近写明外部库限制和删除条件。
- lint 必须在禁用项减少后通过；“加禁用注释后通过”不算完成。

当前 lint 配置把 `no-explicit-any` 设为 warning，因此 warning 不能被当成类型质量合格的证据。视觉证据、Playwright 报告和 SDK 事件都应先转成项目内的窄类型，再进入业务逻辑。

## 1.2 Zod 使用边界

Zod 不是普通业务工具，也不应替代 TypeScript 类型设计。它只用于不可信数据进入系统的边界：

- 环境变量和配置文件。
- 本地 JSON 持久化文件。
- HTTP 请求输入。
- AI 返回的 JSON 和 Playwright 原始报告。

进入领域层之后使用普通 TypeScript 类型和纯函数，不在阶段执行、状态转换和证据遍历中反复调用 `z.object()`、`.parse()` 或 `.safeParse()`。每类外部数据只保留一个 codec/解析入口：

| 数据 | 解析位置 | 业务层使用方式 |
|---|---|---|
| Issue 运行记录 | `src/dag/codecs/IssueRunCodec.ts` | `IssueRun` 类型 |
| 工作流检查点 | `src/orchestration/codecs/WorkflowCodec.ts` | `WorkflowState` 类型 |
| Playwright UAT 报告 | `PlaywrightReportCodec` | `ValidatedUatReport` 类型 |
| 视觉用例和模型结果 | `VisualReviewContract` | `VisualCase`、`VisualReviewOutput` 类型 |

`VisualEvidence` 不再为每一个附件重复创建临时 Zod schema；`DagPhaseRunner` 不直接解析视觉修复 JSON；`UatPhase` 不负责定义持久化 schema。这样可以保留边界校验，同时避免 Zod API 渗入业务代码。

## 2. 关于 `CodexRunner` 与 `ManagedCodexRunner`

这两个类不是同一层的重复实现：

| 类 | 所在进程 | 职责 |
|---|---|---|
| `CodexRunner` | SDK worker | 调用官方 Codex SDK，处理会话、流事件、SDK 结果和中止 |
| `ManagedCodexRunner` | 工作台服务 | 控制全局 AI 并发，启动并等待 worker，处理 IPC、工作目录级取消和进程退出 |

项目约定要求所有 SDK 调用通过受管理 worker，并统一进程树生命周期，因此当前阶段不直接删除 `ManagedCodexRunner`。它解决的是 `CodexRunner` 本身无法解决的进程隔离和全局资源管理问题。

但它目前把多个环境补丁放在同一个文件中。重构后的边界是：

```text
ManagedCodexRunner
  ├─ acquire global limiter
  ├─ spawn sdk-worker
  ├─ forward IPC events
  ├─ await worker exit
  └─ release limiter and cleanup

CodexRunner
  └─ call official Codex SDK
```

复核后不再新增环境辅助模块：删除配置复制 fallback 后，Windows HOME 处理只剩一个短函数；worker 入口属于 worker 生命周期，SDK sandbox 解析留在 SDK 适配层。继续拆文件没有减少职责或重复。

### 2.1 `skipGitRepoCheck` 的实际含义

Codex SDK 默认要求 `workingDirectory` 是 Git 仓库。当前视觉复核流程把：

```text
workingDirectory = .iaf-mini/.../visual-review-tmp/<run>/<uuid>
imagePaths       = 临时目录中的截图
```

由于这个临时目录只放图片，不包含 `.git`，所以调用时传入 `skipGitRepoCheck: true`。这个字段跳过的是 SDK 对工作目录的 Git 预检查，不是对图片路径的判断。

这个事实本身合理，但把它放进公共 `RunOptions` 不合理：当前只有视觉复核使用它，普通 plan、build、verify 调用不应该自行决定是否绕过 SDK 的工作目录保护。

推荐改为以下方案：

1. 保留临时图片工作目录，避免视觉 Agent 直接看到项目源代码。
2. 将视觉调用建模为 `workspace: 'scratch'` 的内部调用，或提供专用的 `runVisualReview()` 入口。
3. 由 `CodexRunner` 根据这个内部调用类型固定设置 `skipGitRepoCheck: true`。
4. 从公共 `RunOptions` 删除 `skipGitRepoCheck`。

不推荐把临时目录初始化成 Git 仓库。那会增加无业务价值的 Git 操作，也会让“只给模型图片”的边界变得更复杂。也不推荐把视觉复核改回项目工作目录，因为模型可能读取源代码，破坏当前的证据隔离意图。

### 2.2 同类的过宽参数

`RunOptions` 目前还有几项把内部约束暴露成了任意调用方都能组合的字段：

| 字段 | 当前问题 | 处理方式 |
|---|---|---|
| `purpose?: string` | 任意字符串会影响网络、搜索和阶段策略 | 改为 `AICallPurpose`，并集中由 `CallPolicy` 生成 |
| `mode?: string` | 任意字符串决定沙箱模式 | 收窄为 `'plan' | 'agent'` |
| `phaseName?: string` | 用于日志和阶段进度标识 | 保留诊断标签；调用策略只由已收窄的 `purpose` 决定，不把日志标签升级为另一套策略 |
| `outputSchema?: unknown` | 任意对象可绕过结果契约 | 改为 `JsonSchema`，视觉契约由专用入口提供 |
| `imagePaths?: string[]` | SDK 本地图片输入 | 保留 SDK 适配接口字段；当前只有视觉复核提供服务端生成的路径，不再新增一层仅转发参数的入口 |
| `skipGitRepoCheck?: boolean` | 公共开关允许任意调用绕过 SDK 仓库检查 | 删除，改为内部 scratch workspace 策略 |

超时、取消信号、工作目录和流事件属于所有 AI 调用共有的生命周期参数，可以保留；但超时延长等策略应由 `CallPolicy` 生成，业务代码不再随意拼装。

### 2.3 `ManagedCodexRunner` 与 IPC 的简化结论

这层不是为了防范理论上的异常而存在，当前有三个实际调用方：

- `AI_MAX_CONCURRENCY` 需要限制计划、任务图、验证和蒸馏共享的 SDK 并发额度。
- `ScopedRunner` 需要按工作目录取消调用，并在服务关闭时等待 worker 及其子进程退出。
- Windows 下官方 SDK 的子进程不向业务层公开 PID；把 SDK 放在 worker 中，才能由统一进程入口执行进程树取消和退出等待。

因此删除 worker/IPC 后，不能只删一个文件，而是要把额度、子进程生命周期和关闭等待重新塞回 `CodexRunner`。这会减少文件数量，却增加 SDK 适配器职责，且丢失当前 Windows 进程树边界。本项目保留两层是职责分离，不属于重复防御。

本轮已删除真正没有业务价值的 `codex-home` fallback。IPC 内部只传调用参数、流事件和最终结果，不解析 Codex CLI 或 JSONL；剩余可简化项限于协议类型命名和 worker 生命周期代码排版，不建议取消 IPC 本身。

## 3. 视觉验收的简化结构

当前 `VisualReviewRunner` 和 `VisualEvidence` 同时处理路径安全、附件解析、图片物化、哈希、工具事件拦截、模型调用、结果修复和清理，导致一个失败有多个可能来源。

目标结构如下：

```text
Playwright 报告
    ↓
VisualEvidence.collect
    ├─ 读取带 iaf 元数据的截图
    ├─ 校验路径位于本次运行 artifacts 目录
    └─ 校验用例、视口和验收引用
    ↓
VisualReviewContract.parse
    ├─ 解析模型 JSON
    └─ 检查是否逐图返回
    ↓
VisualReviewRunner.review
    ├─ 构造 prompt
    ├─ 调用只读 SDK worker
    └─ 返回 passed / failed / needs-review
```

### 3.1 保留的检查

- 截图必须位于本次 UAT 的 `artifacts` 目录下。
- 视觉用例 ID、视口和验收引用必须有效。
- 每个必需用例和视口至少有一张截图。
- 模型结果必须逐图返回，缺失时进入 `needs-review`。
- 本次视觉复核使用只读 SDK 策略。

### 3.2 删除或合并的检查

- 删除重复的 `realpath`、逐层软链接扫描和图片哈希安全检查；本项目截图目录由服务端生成，不是外部上传目录。
- 不再通过 stream 事件名称猜测模型是否调用了 shell 或网页搜索；调用策略集中在 SDK 配置中。
- 清理临时目录只保留一次 `finally` 清理，清理失败记录日志即可，不再把它重新改写成另一种业务结果。
- 将运行时解析 schema 和 SDK JSON Schema 集中到一个视觉契约模块。第一阶段不新增 schema 生成依赖；如果契约频繁变化，再单独引入生成工具。

## 4. 分阶段实施

### 阶段零：先恢复可读性基线

涉及当前所有新增或改动的 TypeScript 文件。

1. 删除文件级 `eslint-disable`，逐项修复超过 100 列的表达式。
2. 为 Playwright 报告、SDK 事件、附件和视觉模型输出补齐最小领域类型。
3. 将业务文件中的 Zod 定义移动到对应 codec/contract 文件。
4. 重新运行 lint，记录剩余 warning；warning 必须有明确的后续清理项，不能作为长期状态。

验收：新增代码不再依赖文件级 lint 绕过；核心业务文件中不直接出现临时 Zod schema 和 `any`。

### 阶段一：建立单一 UAT 凭证

涉及：`UatPhase`、`DagPhaseRunner`、`DeliveryService`、`UatResultStore`、`IssueRunCodec`。

工作内容：

1. 定义一个 `UatReceipt`，包含本次 `runId`、候选提交、计划版本、构建轮次、机器结果、视觉结果和摘要 digest。
2. 由 UAT 阶段生成并保存终态凭证。
3. `DagPhaseRunner` 只消费凭证，不重复拼接 UAT 状态。
4. `DeliveryService` 只调用一个 `assertCurrentUatReceipt()`，不再重复展开十几个字段比较。
5. 无效报告、旧 commit、旧 runId 和 digest 不匹配仍然拒绝交付。

验收：同一份 UAT 凭证可以被阶段恢复、交付校验和前端展示共同读取；三处不再各自实现校验逻辑。

### 阶段二：拆分 Playwright 执行链

涉及：[PlaywrightRunner.ts](../src/e2e/PlaywrightRunner.ts)。

拆成三个函数：

- `runPlaywrightProcess()`：负责启动、取消、退出码和输出文件。
- `parsePlaywrightReport()`：负责报告格式和统计字段。
- `saveUatArtifacts()`：负责 machine JSON、截图证据和当前运行结果。

删除任意错误文本正则推断 `assertion/environment` 的逻辑，改用明确的进程、报告和测试统计事实。

验收：函数不再通过多个 `any` 和长条件表达式判断结果；当前运行报告仍然是唯一有效报告来源。

### 阶段三：收敛视觉验收

涉及：[VisualReviewRunner.ts](../src/e2e/VisualReviewRunner.ts)、[VisualEvidence.ts](../src/e2e/VisualEvidence.ts)。

1. 新增 `VisualReviewContract.ts`，集中视觉结果类型、解析和 JSON Schema。
2. `VisualEvidence` 只负责从 Playwright 结果中收集证据。
3. `VisualReviewRunner` 只负责 prompt、SDK 调用和结果转换。
4. 删除 stream 工具事件拦截、重复路径安全检查和多层清理状态。
5. 把 `purpose` 类型改为 `AICallPurpose`，避免任意字符串调用策略。

验收：视觉复核失败可以明确归类为证据缺失、模型调用失败、模型结果不完整或发现视觉缺陷。

### 阶段四：简化受管理 Codex worker

涉及：[ManagedCodexRunner.ts](../src/ai-runner/ManagedCodexRunner.ts)、[CodexRunner.ts](../src/ai-runner/CodexRunner.ts)、[sdk-worker.ts](../src/ai-runner/sdk-worker.ts)。

1. 保留 `ManagedCodexRunner`，因为它承担全局并发和 worker 生命周期。
2. Windows HOME 处理保留现有短函数，不为几行环境赋值另建文件。
3. 删除视觉复核专用 `queueWatchdog`，所有 worker 共用调用时长上限；SDK 内部活动续时与外层卡死监护各自保留必要职责。
4. 合并重复的取消、超时和 worker 退出结果转换。
5. 修复 `sdk-worker.ts` 的缩进和消息处理结构。
6. 使用本机 Codex 配置；环境不可用时直接报告错误，不复制 `config.toml` 到工作台数据目录。

验收：worker 仍支持 Windows、中文路径、取消、工作目录级 kill、全局并发和退出等待；代码中不再按调用用途维护另一套生命周期。

### 阶段五：前端和遗留代码清理

涉及：[KnowledgeWorkspace.vue](../src/web/frontend/src/components/KnowledgeWorkspace.vue)、阶段元数据和无引用文件。

1. 将知识工作区拆成列表、编辑器和项目资料三个组件。
2. 由 `Phases.ts` 唯一定义阶段，`PipelineMetadata.ts` 派生展示类型和副本；两层职责保留，不再机械合并文件。
3. 清理无生产引用的 `e2e/index.ts`、`preview/index.ts`、`verify/index.ts`。
4. 将生产代码从 `api/mini.ts` 迁移到正式 API 模块后删除它。
5. 确认 `TodolistExtractor` 仅供历史测试使用后移入测试 helper 或删除。
6. 清理没有生产调用方的事件类型和注册校验函数。

## 5. 明确保留的防御边界

下列代码即使项目是学习项目也应该保留：

- 子进程取消、退出等待和进程树清理。
- 聚合状态和报告的原子写入。
- 当前候选 commit、计划版本和 UAT runId 的一致性检查。
- 运行目录路径越界检查。
- 外部 JSON、AI 输出和持久化聚合数据的最小结构校验。

除此之外，新增防御代码必须同时说明对应的真实故障和测试用例；不能只因为“以后可能出错”就增加 fallback。

## 6. 验证要求

每个阶段完成后运行：

```text
npm run typecheck
npm run lint
npm run build
npm run web:build
```

并运行对应单元测试。阶段四必须保留 Windows worker、中文路径、取消和并发测试；阶段一至三必须保留当前 run、commit 和有效报告校验测试。最后再运行完整回归和一次真实 Codex 调用，真实调用与模拟验证分开记录；环境阻断必须据实报告，不能用模拟结果代替。

## 7. 非目标

- 不删除官方 SDK，不重建 Codex CLI 参数或 JSONL 解析层。
- 不取消受管理 worker，不把所有 SDK 调用重新放回服务主进程。
- 不引入多租户、多仓库调度、自动发布或远程知识同步。
- 不为兼容旧格式增加迁移层。

## 8. 本轮实施状态

本轮已完成以下收敛：

- 删除 `RunOptions.skipGitRepoCheck` 公共开关，视觉调用由 `CodexRunner` 根据固定用途内部决定是否跳过 SDK 的 Git 目录预检查。
- 收窄 AI 调用的用途、模式和 JSON Schema 类型；`ManagedCodexRunner` 删除视觉专用 watchdog，统一调用超时边界。
- 重写 `PlaywrightRunner`、`VisualEvidence` 和 `VisualReviewRunner` 的边界代码，移除文件级 lint 绕过、`any`、重复路径检查、工具事件猜测和清理结果分支。
- 新增 `VisualReviewContract`，集中视觉复核与视觉修复结果的运行时解析和 SDK Schema；编排层不再定义临时 Zod schema。
- 新增 `UatResultStore.assertCurrentReceipt()`，`DagPhaseRunner` 与 `DeliveryService` 共同使用当前 UAT 凭证校验入口。
- 删除无生产调用方的 `src/web/frontend/src/api/mini.ts` 兼容 shim，并将测试迁移到正式 HTTP API。
- 修复视觉用例摘要读取时吞掉 JSON 错误的问题；损坏的摘要现在明确失败，不会静默重新生成。
- 视觉附件按项目既定契约固定为 Playwright PNG，删除 JPEG/WebP 后缀推断、格式分支和未使用的 `rawImages` 返回值；视觉复核只保留 PNG 内容校验。
- 删除 `ManagedCodexRunner` 中复制本机 `config.toml` 的 `codex-home` fallback；worker 继续继承本机环境，配置不可用时直接失败。
- 将 Playwright 进程执行移到 `PlaywrightProcess.ts`，并把 UAT 产物写入收敛为 `saveUatArtifacts()`；`UatResultStore.applyMachineResult()` 统一机器结果合并逻辑。
- 删除无引用的 `src/e2e/index.ts`、`src/preview/index.ts`、`src/verify/index.ts`，将仅测试使用的 `TodolistExtractor` 移到 `tests/helpers`。

## 9. 2026-10-04 后续清理结果

本轮完成以下剩余结构调整：

- UAT 结果决策收敛到纯函数模块 `UatOutcome.ts`；执行、持久化和重试意图各有明确入口。
- UAT 必须使用真实 Issue 运行上下文，使用必需的 `UatPhaseStore` 端口替代 `UatTrackerPort` 强制断言、`standalone` 身份和重复配置默认值。
- `UatResultStore.createReceipt()` 统一构造凭证；阶段从聚合记录中的 `uatExecution.runId` 读取本轮运行，不再解析展示副本。交付与签发共用当前凭证校验，并检查计划 digest。
- 机器产物只由 Playwright 执行器原子写入一次；UAT 先写权威终态摘要，再生成展示副本。
- 修复部分视觉缺口消除后被错误标记为通过的问题。只有当前候选提交、计划和构建轮次的行为测试异议才可消除缺口；剩余缺口、未审图片和不完整观察都不能因此放行。
- `KnowledgeWorkspace.vue` 拆为列表、知识编辑器和项目资料组件，编辑状态与错误归各自组件管理。
- 知识 API 边界只解包一次 Memory / Agent Rule JSON，删除组件内反复解析及旧纯文本 fallback；普通自定义正文仍作为正文处理。
- 阶段元数据复用执行层类型，保留展示副本隔离，避免修改展示标签污染执行定义。
- 删除无调用的 `validatePhaseRegistry`、`UnregisteredPhasesError` 和 7 个无生产引用事件类型。

| 阶段 | 代码状态 | 说明 |
|---|---|---|
| 阶段零：可读性基线 | 已落地 | 文件级 lint 禁用已移除；外部解析保留在边界；诊断标签和 SDK 图片输入保留，不再为它们引入转发层。 |
| 阶段一：单一 UAT 凭证 | 已落地 | 统一签发与校验、直接引用当前运行、决策纯函数、权威摘要先落盘。 |
| 阶段二：Playwright 执行链 | 已落地 | 进程执行、报告解析、产物保存已分开；本轮删除了阶段中的重复产物写入。 |
| 阶段三：视觉验收 | 已落地 | PNG 契约、证据与模型边界保留；覆盖缺口不会掩盖其他失败。 |
| 阶段四：受管理 worker | 已落地，调整拆分方式 | 保留 IPC、全局额度、取消及退出等待；删除配置 fallback，不另建没有实际收益的环境文件。 |
| 阶段五：前端和遗留清理 | 已落地 | 知识组件拆分、元数据复用、无引用入口及校验清理完成。 |

上表表示代码结构调整完成；最终验证状态以以下记录为准。此前文档把完整回归失败直接归为“环境问题且与改动无关”，证据不足，本次撤回该结论。

## 10. 本轮验证记录

- 已通过针对 UAT、视觉复核、阶段流程、交付及知识 API 的 8 个文件 / 55 项测试。
- 补充视觉覆盖失败分类后，视觉复核、缺口消解、阶段元数据的 3 个文件 / 31 项测试通过。
- 类型检查、lint、前后端构建通过，`git diff --check` 无空白错误。
- 完整保留测试集首轮运行 116 个文件、888 项测试，881 项通过、7 项失败。失败具体包括：1 项阶段分层依赖、1 项工作台验收数据、2 项机器验收流程的视觉配置、3 项 Windows 子进程清理。
- 阶段层改为必需的存储端口后，架构守卫通过；修正截图/摘要测试数据，并明确机器验收流程不模拟视觉模型。
- 在允许查询与终止测试子进程的环境中，4 个失败文件复验共 11 项全部通过：完整机器验收与交付恢复、Windows 进程取消/超时清理、预览退出和真实工作台浏览器操作。该结果支持首轮 3 项 Windows 清理失败受运行权限影响的判断。
- 最新阶段流程、存储端口、工厂和架构检查复验：4 个文件、37 项全部通过。首轮失败项已全部复验通过；未把分批复验表述为一次从头到尾全绿的运行。
- 真实 Codex 冒烟测试通过：继承本机配置，在中文空格目录生成代码并通过 Node 测试；中止后的 worker 已退出。最初受限环境无法读取系统用户信息，随后在正常用户环境通过原测试脚本验证，没有增加配置复制或生产代码 fallback。

本轮测试报告保存在 `.iaf-mini/code-quality-checks/`：`tests.json` 保留首轮结果，`recheck.json` 保留失败文件复验，`uat-final.json` 记录阶段层最后一次复验。真实 Codex 报告位于该目录下 `codex-smoke/中文 测试 QbUs9O/result.json`。这些是测试产物，不是应用运行数据或旧格式兼容层。

## 11. 代码简洁度审核问题修复

此次针对审核报告中的具体问题进行修复，工作区原有的其他改动继续保留。

- 详情首次加载并行读取详情和日志，删除页面对详情的二次请求；操作由统一入口执行，成功后刷新一次。请求编号与记录版本保护继续保留，切换 Issue 时旧响应不能覆盖新选择。
- 操作错误统一交给页面 `useAction` 展示，删除 composable 中的重复捕获和弹窗。审核提交复用已加载计划的实际版本；未加载或选择其他 Issue 时拒绝提交，不补造默认版本。
- 共享契约复用服务端 `IssueRecord`、`PhaseProgress` 和阶段历史类型；前端仅补充展示字段，必填字段不再伪装为可选字段。相应测试夹具补齐需求创建时间、运行状态与阶段历史。
- 阶段结果改用 `RepairContext` 和 `CurrentRetryContext`，编排层直接消费类型明确的报告、失败项和视觉修复上下文。
- 三个审核路由共用版本、等待状态、审核阶段和异常映射流程；驳回反馈校验与服务层并发版本复核继续保留。
- 删除必填依赖的“不可用”分支、运行状态默认补造、无调用方的重启乐观更新，以及内部工作区字段和配置类型中的冗余默认值／只读再转可写处理。
- 阶段只读取统一事件的 `sessionId`，协议转换留在 SDK 适配器；SSE 去重不再防御已解析 JSON 的循环引用。
- 新增 `PlaywrightReportCodec`，只沿官方 `suites → specs → tests → results` 结构建立通过测试索引；失败、跳过、重试后通过和预期失败均不能作为行为覆盖凭证。同一报告只读取、解析和遍历一次，引用同一源码文件时复用内容。

新增详情回归覆盖重复请求、切换 Issue、实际审核版本和操作错误状态；新增报告解析回归覆盖非测试对象、失败结果、重名测试及多项目结果。流会话测试同时检查流事件和最终结果都写回聚合状态。

验证结果如下：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，包含主代码、脚本、前端与测试 |
| `npm run lint` | 通过 |
| `npm run build`、`npm run web:build` | 后端与前端构建通过 |
| 详情、报告、会话定向回归 | 3 个文件、25 个用例全部通过 |
| 完整保留测试集 | 117 个文件、906 个用例；905 个通过，1 个真实 Git 用例超过 30 秒 |
| DAG 失败文件复验 | 9 个用例全部通过 |
| `npm run test:e2e` | 真实工作台浏览器验收通过 |

超时用例包含六个真实 Git 任务和失败重试，单独运行时仍持续推进并触及原先 30 秒上限，因此将该用例的时限设置为 90 秒后复验；断言成功验证失败节点执行两次并最终合并。浏览器验收与完整保留测试集均通过 `IAF_TEST_BROWSER_CHANNEL=msedge` 使用本机 Edge；默认 Chromium 未安装的尝试不计入通过结果。

真实 Codex 冒烟单独通过：在中文空格目录生成实现和 Node 测试，实际测试退出码为 0，取消检查确认受管理 worker 已退出。此结果与使用模拟 AI／平台的流程回归分别报告。

本次检查、构建日志位于 `.iaf-mini/code-quality-validation-final/`，完整测试与 Edge 验收报告位于 `.iaf-mini/code-quality-validation-edge/`，DAG 复验报告位于 `.iaf-mini/code-quality-validation-recheck/`，真实 Codex 记录位于 `.iaf-mini/code-quality-validation/codex.log` 及其 `codex-smoke/` 子目录。首轮 IPC 通道关闭的中断记录继续保留，不作为最终通过依据。
