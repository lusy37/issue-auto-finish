# 遗留兼容代码盘点

盘点日期：2026-09-12；基线：764d574。范围为当前工程的源码、脚本、测试、配置示例和说明文档，并核对相关符号的生产调用、当前数据写入端及包导出入口。未扫描或修改参考工程的运行数据。

当前工程没有自动导入原项目任务数据的流程。发现的遗留内容主要是报告文件名别名、验证上下文字段别名、已停用状态算法，以及不准确的历史架构注释。以下删除针对当前单仓工作台；不保证仓库外直接导入内部源码符号的调用方继续工作。

## 已删除或精简

| 位置 | 调整 | 删除依据与影响 |
| --- | --- | --- |
| src/web/routes/api.ts、PlanDocViewer.vue | 删除 02-verify-report.md 到 04-verify-report.md 的回退及前端旧名称项 | VerifyPhase、提示词、流水线元数据及交付摘要都使用 02。只有 04 时请求当前报告返回 404；当前报告仍可从 worktree 或 Git 分支读取 |
| src/orchestration/Reducer.ts | 只读取 verifyFailures，删除 failures 别名 | 当前 VerifyPhase 只写 verifyFailures；旧别名仅测试使用。仍过滤非法元素、持久化有效原因与原始报告供下轮 build 使用 |
| src/tracker/BaseTracker.ts | 删除 .tracker-*.tmp 一类旧命名临时文件的启动清理 | atomically 只生成当前文件名加 .tmp- 后缀；保留当前临时文件的崩溃清理。旧命名文件如存在，会留在磁盘，不作为数据读取 |
| src/tracker/ExecutableTask.ts | 删除 taskStatusToUnified、unifiedStatusToCategory | 前者来自已移除的子任务执行逻辑，后者没有生产调用。当前工作台使用 issueStateToUnified 与 issueStateCategory；包根入口未导出这两个函数 |
| src/lifecycle/ActionLifecycleManager.ts | 删除 determineResumePhaseIndex，包括缺少阶段时倒序猜测的分支 | 仓库中只有测试调用，当前调度使用 TrackerStateStore、OrchestrationState 和 Reducer。保留实际使用的阶段前驱查询、状态分类与展示投影 |
| src/orchestrator/TrackerStateStore.ts、StateAdapter.ts、src/tracker/IssueState.ts | 删除 derivePhaseHistory 及转导出，直接使用 phaseHistory ?? [] | 原函数仅重复同一个缺省值表达式，没有迁移行为 |
| src/phases/VerifyPhase.ts | 删除 VerifyRunResult 类型 | 没有引用；当前 run 返回 PhaseIntent |
| tests/unit/executable-task.test.ts、workspace.test.ts | 删除未使用的子任务夹具和不存在的多仓导入 | 它们没有被有效测试执行，不代表产品仍支持子任务执行器或多仓工作区 |
| tests/integration/review-history-path.test.ts | 重命名原 multirepo 测试，覆盖项目根目录与子目录 | 原两项测试使用相同路径，并非两种兼容布局；现在分别验证 projectSubDir 为空和非空的当前行为 |

## 保留的当前功能

| 位置或机制 | 保留原因 |
| --- | --- |
| BaseTracker 的 iaf-mini/v1 格式检查、IssueTracker 的来源与状态校验 | 本地 JSON 不受 TypeScript 运行时约束，需要拒绝结构损坏和不支持的输入。不是数据迁移器。本次统一存储格式错误的提示，附上文件路径，并处理 JSON 根值为 null 的情况 |
| IssueState 与 OrchestrationState 的投影、TrackerStateStore 的可选状态缺省处理 | 工作台与轮询读取 IssueRecord，编排器读取编排状态；当前类型仍允许缺少快照。不能仅因 legacyState 命名而删除。该参数已改名为 trackerState |
| phaseProgress 初始化和展示推导 | 新任务在 SetupStep 才初始化阶段进度；首次展示、进度未提供时仍需要默认状态 |
| lastErrorRetryable、processingLock、resetGeneration 的缺省值 | 分别表达未限定重试、未持锁和未发生重置；并发重置检测仍依赖代数比较 |
| 审核历史备份、可选 planSnapshot、计划文件的 Git 读取 | worktree 尚未创建、缺失或被清理时仍需展示反馈与报告；计划缺失时也允许保存驳回意见 |
| Runner 会话归属检查、恢复失败后的新调用 | codex: 是当前适配器生成的命名空间，不透明标识仍须校验；会话失效时保留计划和反馈上下文是中断恢复能力 |
| 原子写入失败保护、当前临时文件清理、锁、取消、有限重试、交付防重 | 都是当前业务可靠性要求；测试中“旧数据”指上次成功写入内容，不是原项目数据格式 |
| .iaf-mini 数据目录及 iaf-mini/v1 格式名 | 当前存储约定中的名称，与旧数据导入无关，不因去除展示定位而改动数据路径 |
| .claude-plan 路径及计划目录忽略规则维护 | 路径名虽沿用历史命名，当前服务、提示词、报告和 Git 读取都在使用。统一维护忽略规则也用于补齐本次任务生成的不完整配置 |
| 知识规则 deprecated、历史版本、报告中英文解析 | 分别属于规则停用、版本对比及模型输出解析；不是废弃代码标记或旧任务迁移 |
| API/SSE 契约与流水线展示类型 | 保留现有接口字段和事件名。本次未借清理兼容逻辑缩减公共状态类型或改变接口路径 |

## 表述清理

- 开发约定统一称为 AI Issue 开发工作台；当前源码、测试、脚本、配置示例不强调展示用途定位。
- 将“旧记录兼容”注释改为首次初始化、可选值默认、并发保护等实际含义。
- 删除空类型注释和对旧执行流程的描述；会话说明改为当前 Runner 恢复接口。
- 原子写入保护、业务历史版本及历史验收记录保留其真实含义，不按“旧”字机械删除。
- 已发生的底层依赖迁移记录保留，另注明本次进一步删除旧临时文件命名分支，避免把历史实现误作当前实现。

## 验证与提交

实现提交：e4fb2f2（refactor: 清理遗留兼容分支与误导性注释）。相对基线，src 与 scripts 新增 45 行、删除 186 行，净减少 **141 行**，包含注释与空行，不计测试、文档和依赖。

| 检查 | 本次结果 |
| --- | --- |
| npm run typecheck | 通过，覆盖后端、脚本、前端 |
| 相关回归（14 个文件） | 249 项通过 |
| npm test | 97 个文件、924 项通过 |
| npm run build / npm run web:build | 后端、CLI、类型声明和前端构建通过 |
| npm run test:e2e | 本机 Chrome 工作台六入口验收 1 项通过 |
| Windows 专项 | 已随 npm test 通过：中文空格路径、cmd 启动、进程树清理、端口释放；不重复累加数量 |

测试数由 941 变为 924：删除无生产调用方法对应的 25 项测试（恢复索引 18 项、分类辅助函数 7 项），新增存储结构检查 5 项、报告读取检查 3 项。验证失败原因过滤及审核路径测试改为有当前业务意义的场景，未减少这些用例数量。

本次验收环境为 Windows、Node v22.18.0、本机 Chrome。没有执行真实 Codex 调用或 GitHub 外部交付，也没有 Linux/macOS 实测结果。原始日志位于 .iaf-mini/compatibility-audit/；提交的 [验收摘要](evidence/compatibility-audit.json) 记录日志路径、摘要校验值与实现提交。
