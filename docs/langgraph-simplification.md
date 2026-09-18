# LangGraph 职责收口与精简

本次调整基于 `codex/langgraph-native` 的 `d51c261`。外层流程和 build 内部依赖调度继续由 LangGraph 执行；业务事务负责计划、执行凭证、预算和资源生命周期。精简的目标是减少重复流程控制，不把 Git 或平台操作的业务事实交给检查点猜测。

## 当前职责边界

| 能力 | 负责方 | 保留原因 |
| --- | --- | --- |
| 阶段顺序、审核中断、修复回边、断点位置 | `IssueWorkflow` 的 LangGraph 图 | 执行位置只有一个依据 |
| build 任务依赖、并行调度和汇合 | LangGraph 子图 | 复用框架调度及检查点 |
| Issue 发现、并发准入、处理锁、执行前准备 | `IssuePoller`、`IssueService` | 属于进入图之前的服务生命周期 |
| 暂停和取消 | 停止意图、取消信号、受管理进程 | 保存用户意图并确认实际进程退出 |
| 重试和集成修复额度 | 每 Issue 聚合事务 | 跨重启和人工继续保持业务预算 |
| 计划版本、Git 合并、UAT 和交付结果 | 业务凭证及不可变计划 | 校验真实提交、当前报告和平台操作，防止重复副作用 |
| 业务生命周期 | `IssueRecord.lifecycle` | 唯一持久化的调度、人工介入和交付生命周期 |
| 页面状态 | `PipelineProjection` | 从 lifecycle 单向生成动作和文案，不形成第二份状态 |
| 阶段进度和历史 | `phaseProgress`、`phaseHistory` | 保存审计、结果和会话，不推导图的下一节点 |

`workflow.results` 和 Git 合并凭证继续保留。节点内的业务提交与随后发生的框架写入存在崩溃窗口，仅靠检查点不能保证业务副作用只执行一次。自定义 Checkpointer 继续复用每 Issue 的聚合存储，不引入第二套运行数据库。

## 删除的旧控制代码

- `pendingActions`、消费回调、`applyPendingAction` 和专用 `PhaseAbortedError`：生产没有写入入口，暂停及取消已经使用停止意图和取消信号。
- `getPhasePreState` 及继续、重做时伪造上一阶段完成状态的逻辑：恢复由原检查点定位；重做由新的 `workflow.generation` 和 `entry` 定位。
- `ActionLifecycleManager` 与其双向状态映射：调度资格直接读取 `IssueLifecycle`，页面动作由纯投影函数生成。
- 持久化及 REST 中的 `orchestrationState`、`state`、`currentPhase` 等重复投影：v5 聚合与 API 只使用 `lifecycle`。
- `progress.json` 读写和 fallback：阶段进度、会话 ID 和页面详情统一读取 Issue 聚合记录。
- 展示状态类型中的四个无调用分类函数：保留服务准入判断，避免存在两组驱动资格规则。
- 手写的检查点特殊通道索引：改用框架导出的 `WRITES_IDX_MAP`，并显式声明已安装的 checkpoint 包依赖。

继续和失败重试现在恢复为可调度的 `ready` 生命周期。这里表示工作区可进入执行，不再表示通过某个前驱阶段定位流程；具体节点仍取自检查点。

## 恢复边界修正

审核节点先记录进入审核，框架保存中断后才发布 `waiting(review)` 生命周期。在任一写入边界退出，启动恢复都能再次核对该图。运行格式已升级为 `v5-langgraph`，明确拒绝其他格式，不保留读取或迁移分支。

已进入审核的计划在恢复时继续等待中断决定，不能因为审核配置被关闭而自动通过。批准和驳回仍绑定不可变计划版本。

PR 冲突修复入口在同一事务中保存修复任务、消耗额度，并创建从 build 开始的新图轮次。保留原 PR 身份，重新执行构建、验证、UAT 和交付；提交前重新检查停止意图、执行轮次和额度，避免异步查询期间的状态变化被覆盖。

## 状态与校验单一化

当前 Native 不再同时持久化多套流程状态：

- LangGraph checkpoint 是节点位置、审核中断和恢复入口的唯一依据；
- `IssueLifecycle` 是调度、暂停、失败、交付中的唯一业务生命周期；
- `TaskRun`、`CallRecord`、验证收据和 `DeliveryIdentity` 是业务凭证，不与生命周期合并；
- `phaseProgress` 只用于阶段审计和会话恢复；本轮 UAT 要求由不可变 `workflow.definition.phaseIds` 表达；
- `processingLock`、`buildGeneration`、`workflow.generation` 和重试预算各自保留独立职责，不塞入生命周期。

所有生命周期变更通过 `applyIssueLifecycleEvent()` 完成，并拒绝已完成后重入阶段、暂停时完成阶段、错误计划版本审核等非法转换。`delivering` 表示远程交付正在进行或结果尚未确认，只有交付副作用确认完成后才进入 `completed`。

运行时结构校验集中在 `dag/codecs` 与 `orchestration/codecs`。Zod 只解析聚合 JSON、AI 输出、审核输入和框架 StateSchema；跨字段凭证、DAG 依赖、审核反馈和工作流定义规则使用普通 invariant 函数，领域类型文件不直接依赖 Zod。

## 验证与限制

回归覆盖中断保存前退出、等待生命周期保存失败、恢复时配置变化、暂停继续、自动重试预留、指定阶段重做、已完成流程的冲突修复、进程树退出和审核凭证展示。旧引擎对照测试已经删除，测试统计只包含当前实现。

最新代码基线 `cf49548` 的当前套件为 106 个文件、876 项测试。受限环境中的完整运行有 869 项通过，7 项只因 `taskkill` 权限和子进程资源限制失败；相同 7 项在允许 Windows 进程树管理的环境中 14/14 通过。类型检查、Lint、前后端构建、真实 Edge 工作台 E2E 和 Windows 专项也全部退出 0。结构化结果、环境说明和源码散列见 [最新验收记录](evidence/langgraph-native-validation.json)。2026-09-14 的历史精简审计仍保留在 [旧验收记录](evidence/langgraph-simplification.json)，不与本轮统计混用。

AI 和 GitHub 自动回归使用模拟实现；Git、Windows 进程树和浏览器使用本机实际环境，因此不能把该结果表述为真实 Codex 调用或真实 GitHub 写入验收。GitHub 已发出的外部请求仍不能和本地 JSON 跨系统回滚，本地只保证旧执行身份的迟到响应不会覆盖新状态。

页面和 SSE 直接读取 `lifecycle`；`PipelineProjection` 只计算展示动作与文案，不保存或回写状态。审核面板读取明确的 `run.review.decision`，不会把通用 `ready` 生命周期猜成审核通过。
