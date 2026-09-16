# LangGraph 原生迁移与阅读路径

本分支为 codex/langgraph-native，独立工作树为 .iaf-mini/worktrees/langgraph-native。它最初从 main 的 dee9fe4 建立，但当前是独立技术方案：只对齐 REST API 和用户可见业务语义，不以 main 的内部状态驱动器为实现标准，也不要求 rebase 或最终合并回 main。原 main 和之前的 langgraph-experiment 工作树均保留。

2026-09-14 的后续职责收口、冗余删除及恢复修正见 [精简说明](langgraph-simplification.md)。2026-09-16 又完成了生命周期单一化和 Codec 分层：持久化的 `IssueLifecycle` 表达业务生命周期，LangGraph checkpoint 表达执行位置，旧状态枚举仅在 REST/事件边界按需投影。

随后从 main 适配的预览重启、交付回写校验和回收目录后完整重做，见 [三项业务修复](native-business-fixes.md)。

2026-09-14 已完成两组真实 GitHub、Codex SDK 和 Chrome 验收：[正常需求闭环](native-live-uat-20260914.md) 完成三任务开发及 8 项 UAT，记录了初期服务中断后的人工恢复；[独立故障修复闭环](native-live-repair-20260914.md) 首轮正式 UAT 3 项断言失败后，自动集成修复 1 轮，同一组 8 项浏览器测试全部通过并交付 PR，审核后没有人工重试。两组均验证了完成后的重启幂等性。

## 当前由谁负责什么

| 能力 | 迁移前 | 当前实现 |
| --- | --- | --- |
| 外层阶段顺序 | 自研驱动循环、转换表、Reducer | IssueWorkflow 的 StateGraph 节点和 Command 路由 |
| 审核等待 | 自研 gate 状态与批准转换 | 原生 interrupt；审核接口提交 Command({ resume }) |
| 重启恢复位置 | 根据父状态、当前阶段和历史推算 | checkpointer 中的下一节点、任务与 pending writes |
| 普通阶段自动重试 | 驱动器内部循环和计数 | 节点 retryPolicy，业务事务保留跨重启的额度 |
| 验证失败修复 | 转换表中的 retry-from | verify / uat 节点返回指向 build 的 Command |
| build 内任务并行 | ready 队列、inFlight、Promise.race | 原生子图与依赖边；依赖数组表达汇合 |
| 人工指定阶段重做 | 修改父状态后重新推导位置 | 新 workflow generation 和明确 entry；旧图不能写回 |
| Git、AI 进程、验收与交付 | 业务代码 | 继续由业务代码校验和执行 |

每轮任务的阶段列表在 Issue 初始化或完整重做时按当时配置固化，通常为 plan → review → build → verify → uat → deliver；关闭 E2E 时则由 verify 直接进入 deliver。阶段产物同步有独立 publish 节点；verify 和有效 UAT 失败可以在共享修复额度内返回 build。

“原生迁移”仍需要业务判断。框架不知道 Git 提交是否可信、审核的是哪版计划，也无法根据模型文字判断浏览器是否通过。这里保留的是业务事实及进程管理，不是另一套流程驱动器。

生产编排目录（src/orchestration 与 src/orchestrator）从 20 个文件、3,532 行变为 17 个文件、2,346 行，减少 1,186 行，约 34%。统计包含注释，不含测试参考目录；它衡量本次编排层精简，不能代表整个项目或依赖包的体积变化。

## 先读这几个文件

1. [IssueWorkflow.ts](../src/orchestrator/IssueWorkflow.ts)：先看构造器中的图，再读 drive、review、runPhase。尝试回答：正常下一步、审核恢复、修复回边分别在哪里声明？
2. [IssueLifecycle.ts](../src/tracker/IssueLifecycle.ts)、[WorkflowState.ts](../src/orchestration/WorkflowState.ts)、[Phases.ts](../src/orchestration/Phases.ts)：区分业务生命周期、图位置和固定阶段名。这里已删除旧 Pipeline.transitions、awaitGate 和 awaitAsync 协议。
3. [IssueCheckpointer.ts](../src/orchestrator/IssueCheckpointer.ts)：理解 thread_id、checkpoint namespace、checkpoint、pending writes。随后看 [IssueRunStore.ts](../src/dag/IssueRunStore.ts) 的 transaction，理解如何原子落盘；运行时输入校验集中在 `dag/codecs` 与 `orchestration/codecs`，跨字段规则集中在普通 invariant 函数。
4. [RunWorkflowStep.ts](../src/orchestrator/steps/RunWorkflowStep.ts) 和 [DagPhaseRunner.ts](../src/orchestrator/DagPhaseRunner.ts)：看依赖如何注入、AI 阶段怎样生成业务凭证、实际端口怎样交给 UAT。
5. [TaskGraphExecutor.ts](../src/dag/TaskGraphExecutor.ts)：先看 execute 中的子图和依赖边，再看 executeTask / integrate。框架负责并发调度，Git 合并仍串行执行。
6. [IssueService.ts](../src/orchestrator/IssueService.ts)：最后读 API 与轮询入口、Worktree 准备、取消、重试和恢复。它负责资源生命周期，不再用状态转换表驱动阶段。
7. [原生恢复测试](../tests/integration/langgraph-native.test.ts)、[审核 API 测试夹具](../tests/helpers/review-api.ts)、[完整业务验收](../tests/integration/mini-workflow.test.ts)：按批准、驳回、重启、失败、暂停的顺序运行和调试。

所有源码引用使用相对于本文的 Markdown 链接，可直接在 VS Code 的 Markdown 预览中点击。

## 审核与恢复的具体行为

计划完整保存后，review 节点通过 interrupt 挂起。审核接口验证 planRevision 和当前中断，提交 resume。该请求只执行审核节点，保存下一节点后返回；后续轮询使用 invoke(null) 继续，不在 HTTP 审核请求内调用 AI。

批准或驳回、完整计划快照、反馈、阶段历史和节点结果收据在同一个 Issue 事务中提交。即使业务结果已经保存、框架写入随后失败，重启也能复用结果，避免重复规划或重复决定审核。

普通自动重试由 retryPolicy 执行；预算持久化，重启和手动继续不返还已用额度。`phaseExecutions[phase]` 表示实际开始的阶段执行次数，`retryUsed[phase]` 表示已占用的自动重试预算；预算不小于执行次数时，表示下一次重试已经预留。retryPolicy 与重启后的 drive 共用幂等预留逻辑，因此崩溃窗口不会重复扣减，最后一次已预留预算仍可被 Poller 驱动；`hard-no-auto` 或预算耗尽则进入人工失败。业务修复次数与普通调用失败重试是不同预算。暂停先保存停止意图，再取消排队和在途进程；继续时恢复原检查点。显式从某阶段重做开始新的图轮次，完整重做还会更新 buildGeneration。

调试时可以在现有 IssueWorkflow 实例上调用 getState()，查看 next 与 tasks 中的 interrupts；getStateHistory() 读取当前图轮次的历史。不要通过修改 REST 返回的 `state`、`currentPhase` 或 `orchestrationState` 驱动流程：它们由持久化的 `lifecycle` 单向生成。用户操作应经过审核、继续、重试或指定阶段重做的服务入口。

## 本地 JSON 与新数据格式

每个 Issue 的 DATA_DIR/issues/<编号>/run.json 是唯一运行状态文件。顶层 `lifecycle` 保存业务生命周期；`workflow` 保存框架序列化后的检查点、待提交写入、已提交的阶段结果和附加副作用记录；`phaseProgress` 只保存阶段审计时间、结果和可恢复会话，不再承担 E2E 配置或流程定位。每轮是否包含 UAT 由 `workflow.definition.phaseIds` 在初始化或完整重做时固化。不可变 plans/<revision>.json 仍保存计划及审核依据。

不再写入 `artifacts/progress.json`。页面详情直接读取聚合记录中的阶段投影，会话恢复也通过 `IssueTracker` 读取同一份 `phaseProgress`，避免磁盘上出现两份可能分叉的进度状态。

自定义 IssueCheckpointer 实现框架的存储协议，目的是复用现有每 Issue 聚合事务。另开一个检查点数据库会产生两个独立写入边界，不能自动保证审核事实与执行结果一致。

运行格式为 `iaf-mini/issue-run/v4-langgraph`。旧 v3、v2 和实验分支数据不会自动迁移或覆盖；请使用这个工作树自己的新 DATA_DIR。演示默认使用 `.iaf-mini/demo-langgraph-v4`。正式配置若指向原工作树的数据目录，应显式选择新目录，并由原程序继续管理需要恢复的旧任务。

Zod 只保留在不可信数据边界：聚合 JSON、AI 计划输出、审核输入及 LangGraph `StateSchema`。`contracts.ts` 和 `WorkflowState.ts` 只定义 TypeScript 领域类型；DAG 循环、审核反馈、版本与凭证归属等跨字段规则由普通 invariant 函数表达，避免业务规则隐藏在大型 Schema/refine 中。

## 文件与目录调整

| 原位置 | 新位置与含义 |
| --- | --- |
| orchestrator/PipelineOrchestrator.ts | [IssueService.ts](../src/orchestrator/IssueService.ts)，外层服务及资源管理 |
| orchestrator/steps/PhaseLoopStep.ts | [RunWorkflowStep.ts](../src/orchestrator/steps/RunWorkflowStep.ts)，装配并运行原生图 |
| orchestrator/steps/CompletionStep.ts | [DeliverIssueStep.ts](../src/orchestrator/steps/DeliverIssueStep.ts)，执行交付 |
| orchestration/Pipeline.ts | [Phases.ts](../src/orchestration/Phases.ts)，固定阶段元信息 |
| orchestration/Intent.ts | [PhaseResult.ts](../src/orchestration/PhaseResult.ts)，阶段业务结果 |
| pipeline/PipelineDefinition.ts | [PipelineMetadata.ts](../src/pipeline/PipelineMetadata.ts)，展示与生命周期元数据 |
| deploy/ | [preview/](../src/preview/index.ts)，本地预览服务 |

生产代码删除 Orchestrator、Reducer、Transitions、TrackerStateStore、StateAdapter、StandardPhaseRunner、DefaultSideEffectExecutor 及无调用的旧回退查找函数。对外源码导出也改为 IssueService；直接引用旧类或路径的调用方需更新。

浏览器验收还发现并修复了隐藏工作树目录的页面访问问题：Express 发送详情页时使用明确的前端根目录，避免 .iaf-mini 父目录导致页面返回 404；静态资源仍拒绝访问隐藏文件。

## 验收分层与实际代价

保留的旧状态机契约及其测试集中在 [tests/reference](../tests/reference/README.md)，不进入生产构建。它们用于迁移前后的对照，其通过结果不能计作新图的运行时验收。当前业务预算测试、审核 API、完整流程、Git 崩溃恢复和浏览器测试直接使用新的执行路径。

LangGraph 让阶段流转、人工介入和恢复入口更集中，但引入了框架依赖以及 checkpoint / thread / superstep 概念。图的同一超步存在同步边界，因此它不保证比原先随任务完成立即派发下游的调度器更快。Git 合并、全局 AI 额度和外部服务通常仍决定实际吞吐。

本地聚合 JSON 适合当前单实例和有限任务规模。保留历史检查点会增加文件体积及每次原子写入成本；若将来规模扩大，可再评估数据库及检查点保留策略。附加评论同步使用操作标记去重并允许失败，不能承诺远程平台与本地磁盘之间的严格一次事务。

真实 Git、真实浏览器和模拟 AI/平台的结果分别记录；没有运行真实 Codex 或真实 GitHub 写入时，不将模拟回归表述为真实 AI 验收。

本机完整验收使用真实 Chrome，并串行执行，以避免多个真实 Git/浏览器测试同时冷启动触发测试时限。功能断言、节点重试额度和生产执行超时保持各自原有语义；测试进程的等待预算单独设置。

~~~powershell
$env:IAF_TEST_BROWSER_CHANNEL='chrome'
npm run typecheck
npm run build
npm run web:build
npm run test:all -- --maxWorkers=1 --testTimeout=180000 --hookTimeout=60000
~~~

本轮类型检查、后端构建、前端构建均通过。完整运行执行了 109 个测试文件、1,017 项测试，首轮 1,016 项通过；唯一失败是 UAT 成功样例超过测试夹具的 20 秒进程启动时限。随后仅调整该夹具的进程等待预算至 60 秒及整项测试等待预算至 300 秒，保留 Playwright 测试自身的 200 毫秒超时与全部结果断言，原文件复验通过。生产代码没有再修改。

完整运行与该文件复验合并覆盖 1,017 项：当前实现 101 个文件、939 项；旧契约参考 8 个文件、78 项。当前实现包含 10 项 LangGraph 原生恢复边界测试、真实 Git 操作及强杀恢复、真实 Chrome 工作台验收。本轮没有调用真实 Codex，也没有执行真实 GitHub 写入。

[验收记录](evidence/langgraph-native-validation.json) 保留首轮结果、定向复验结果、逐文件归属、执行命令和最终源码散列，不将分轮复验表述为首轮全绿。完整原始日志位于本工作树的 .iaf-mini/native-validation/。

## 2026-09-17 最新验证

本轮在代码基线 `cff9854` 上重新执行完整门禁。为降低 Windows 上真实 Git 子进程与浏览器冷启动的资源竞争，完整 Vitest 套件使用单 worker；测试逻辑、生产超时和断言没有放宽。浏览器使用本机 Microsoft Edge，Playwright 以本次进程退出码和本次生成结果判断，不复用旧报告。Windows 进程测试在允许 `taskkill /T /F` 的环境中执行，验证取消和超时都会等待整棵进程树退出。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，退出码 0 |
| `npm run lint` | 通过，退出码 0；0 error、23 个既有 warning |
| `npm test -- --maxWorkers=1` | 114 个文件、1,010 项测试全部通过，退出码 0；674.25 秒 |
| `npm run build` | 通过，退出码 0 |
| `npm run web:build` | 通过，退出码 0 |
| `IAF_TEST_BROWSER_CHANNEL=msedge npm run test:e2e` | 1/1 通过，退出码 0；28.93 秒 |
| `npm run test:windows` | 1/1 通过，退出码 0；4.84 秒 |

本轮回归使用真实临时 Git 仓库和真实 Edge 浏览器；AI 与 GitHub 平台均为模拟实现，没有把模拟结果表述为真实 Codex 或真实 GitHub 写入。GitHub 已发出的外部请求仍无法与本地 JSON 做跨系统事务回滚；实现只保证旧 workflow generation、旧派发或旧候选提交的迟到响应不能覆盖新的本地状态。完整结构化证据见 [最新验收记录](evidence/langgraph-native-validation.json)。
