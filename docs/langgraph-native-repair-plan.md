# LangGraph Native 修复与双图展示计划

日期：2026-09-20。状态：A～F 已实施；此前产物修复见第 9 节，本轮记录见第 10 节。

适用分支：`codex/langgraph-native`，工作树：`E:\Edge_Load\issue-auto-finish\.iaf-mini\worktrees\langgraph-native`。依据为该工作树当前未提交变更、TODO 审查和全仓检索结果。实施前重新确认差异，保留用户正在补充的注释和已有修改。

目标：先修正影响执行、验证和页面判断的问题，再统一重复规则、清理旧调用路径，最后增加 Issue 主流程与 build 任务 DAG 的展示。优先级表示影响程度，批次表示建议实施顺序；下表保留审查时的依据和验收目标，当前完成状态以第 10 节为准。

## 1. 总体计划表

| 批次 | 优先级 | 范围 | 前置依赖 | 完成标志 | 相对工作量 |
| --- | --- | --- | --- | --- | --- |
| 0：建立基线 | 前置 | 固定当前工作树基线；确认保留测试；登记已有失败与测试类型缺口 | 无 | 能区分原有问题、本次修复和用户改动 | 小 |
| 1：执行与验证 | P1 | A1 调用策略、A2 蒸馏只读、A3 Verify 遗留规则 | 批次 0 | 配置实际传递到 worker；蒸馏只读；验证不再依赖计划勾选状态 | 中 |
| 2：页面与平台行为 | P2 | B1 元数据降级、B2 标签归属 | 批次 0，可与批次 1 分别交付 | 元数据失败后可重试；计划保持只读；交付保留无关标签 | 小 |
| 3：公共规则与接口 | P2/P3 | C1 格式标识、C2 限额、C3 提示词与输出提取、C4 产物元数据、C5 协议前缀 | A1、A3；B1 的行为约束 | 同一规则只有一个定义，关键持久化语义保持明确 | 中 |
| 4：遗留实现清理 | P2/P3 | D1 旧阶段路径、D2 孤立工具、D3 旧事件和预览标记、D4 文档注释 | C3、C4；E3 随批推进 | 先迁移有效测试，再删除失去职责的代码 | 中 |
| 5：性能与工程约束 | P2/P3 | E1 日志写入、E2 预览就绪、E3 测试类型、E4 重复默认值 | 可单独实施；E3 从批次 0 开始 | 日志不逐条全量扫描；预览有就绪证据；测试错误参数能被类型检查发现 | 中 |
| 6：双图展示 | 后续增强 | F1 主流程、F2 任务 DAG、F3 联动与生命周期说明 | B1、C2、C4、D3 | 两张图反映同一轮真实执行，正确区分 DAG 构建与集成修复 | 大 |

建议按条目或紧密相关的小组提交，避免把行为修复、文件搬迁和图形界面混成一个改动。先完成批次 1、2，再安排批次 3～5；双图展示独立验收。工作量为相对估计，主要不确定性是旧测试迁移和图状态投影，不承诺固定日历日期。

## 2. 先修复真实行为

| 编号 | 判断与证据 | 修复方案 | 验收标准 |
| --- | --- | --- | --- |
| A1 · P1 | [BasePhase](../src/phases/BasePhase.ts) 传递完整超时参数；[DagPhaseRunner](../src/orchestrator/DagPhaseRunner.ts) 和 [TaskGraphExecutor](../src/dag/TaskGraphExecutor.ts) 的任务、冲突修复、集成修复、UAT 准备调用只传总超时。空闲超时和延长策略在这些路径中没有同等生效。 | 抽取类型化 AI 调用选项构造函数，显式区分用途、读写模式和超时策略；统一传给受管理 runner。草稿生成、连接检查等可以保留用途明确的独立总超时。 | 模拟捕获每种真实入口的选项，验证完整传参；覆盖取消、空闲超时、总超时与有限延期，worker 和全局额度机制继续生效。 |
| A2 · P1 | [MemoryDistiller](../src/distill/MemoryDistiller.ts)、[AgentRuleDistiller](../src/distill/AgentRuleDistiller.ts) 没有设置 `mode`；[CodexRunner](../src/ai-runner/CodexRunner.ts) 对非 `plan` 模式选择 `workspace-write`。这是可写权限暴露，尚无证据表明已误改仓库。 | 两条蒸馏调用显式使用只读策略，先映射到现有 `mode: 'plan'`。AI 返回建议动作，由服务端验证后保存经验、规则。与 A1 共用调用策略，但可先做最小修复。 | 两类蒸馏的 runner 参数均为只读；失败、取消、无有效动作不会产生模型直接写仓库的路径；现有服务端保存功能通过回归。 |
| A3 · P1 | [VerifyReportParser](../src/verify/VerifyReportParser.ts) 仍将 `Todolist: 0/1` 计入失败；[config-schema](../src/config-schema.ts) 中待办检查开关没有对应业务消费。原生流程已使用不可变计划和任务合并凭证。 | 删除以计划勾选完成度判定验证成功的旧规则，同步整理 Verify 结果类型、日志、有效提示词和无效配置。任务是否完成由 DAG 凭证约束；检查命令结果仍由 Verify 契约判定。 | Lint/Build/Test 明确通过且只存在未勾选描述时，不再仅因勾选状态失败；任一检查失败、结果缺失或报告无效仍不能通过。不可变计划未被要求改写；UAT 仍依据本次退出码和有效报告。 |
| B1 · P2 | [usePipeline](../src/web/frontend/src/composables/usePipeline.ts) 在元数据加载失败后保留 `loadPromise`，后续调用无法重新请求；降级逻辑把 `01-plan.md` 标为可编辑。服务端仍拒绝写计划，问题表现为错误入口。 | 成功缓存数据，失败释放请求状态；并发加载合并为同一请求。未取得编辑权限元数据时默认只读。阶段显示优先使用当前 Issue 固化的 `workflow.definition.phaseIds`，缺失时使用明确降级状态。 | 首次失败后再次加载会请求并可恢复；并发加载不重复请求；元数据不可用时计划无编辑入口；关闭 UAT 的 Issue 不被默认列表补出一个待执行 UAT。 |
| B2 · P2 | [DeliverIssueStep](../src/orchestrator/steps/DeliverIssueStep.ts) 使用 `startsWith('auto-finish')` 过滤标签，会误删 `auto-finish-tools` 等无关标签；其他状态更新位置的匹配口径不统一。 | 定义工作台标签名称及归属判断：仅处理精确根标签 `auto-finish` 和约定的 `auto-finish:` 命名空间。初始化、失败和交付共用该规则。 | 用模拟平台验证原有状态标签被正确替换；`auto-finish-tools`、`bug` 等标签保留；整个回归过程不写真实 GitHub。 |

A3 同步检查中英文提示词的实际引用。历史模板只有确认不再用于真实执行后才删除；不能只删解析器中的一条判断而继续要求模型报告计划勾选完成率。

## 3. 统一公共规则，控制抽象范围

| 编号 | 范围与判断 | 具体计划 | 验收标准 |
| --- | --- | --- | --- |
| C1 · P2 | [DAG contracts](../src/dag/contracts.ts)、[共享 workbench](../src/shared/workbench.ts)、[DraftService](../src/demand/DraftService.ts) 等重复定义格式字符串。格式标识有必要，重复字面量可以整理。 | 按领域集中定义运行、计划、草稿、tracker 格式标识。浏览器需要的定义放在不依赖 Node 的共享模块。区分格式号、`run.version`、`planRevision`、`buildGeneration`、`workflow.generation`。 | Codec、写入方、演示与契约测试引用一致；未知格式仍明确拒绝。仅提取常量不升级格式，不把所有对象改成同一个版本号或运行时配置。 |
| C2 · P2 | [TaskPlanCodec](../src/dag/codecs/TaskPlanCodec.ts) 的 20/19、计划提示词中的 20、冲突修复代码和 Codec 中的 2 需要一致；DAG `N + 2` 是图执行步数上界，当前没有证据表明存在越界缺陷。 | 统一最大任务数，并据此推导依赖数量上限；统一冲突修复累计上限。为 DAG 递归上界使用命名函数/常量并解释超步含义；记录主流程 `recursionLimit: 200` 的用途与业务循环上限之间的关系。 | 单节点、20 节点长链、分叉汇合都能完成；非法/循环依赖仍拒绝；冲突修复耗尽后停止，重启和继续不返还次数。阶段重试、集成修复与冲突修复预算保持各自语义。 |
| C3 · P2 | 任务执行、冲突修复、集成修复、UAT 准备提示词嵌在执行器中；草稿、计划和蒸馏存在重复 JSON 提取逻辑。 | 将提示词构造成类型化纯函数，放入现有 prompts 体系；提取共用的 JSON/代码围栏识别工具，各业务继续独立校验结构。格式错误显式报错，只有合法空动作才表示无需更新。 | 调用路径传入完整批准计划、验收要求和必要上下文；审核驳回仍带完整上版计划及反馈；覆盖合法 JSON、围栏 JSON、空输出、无效结构，不引入模板引擎或 SDK JSONL 解析层。 |
| C4 · P2 | [Phases](../src/orchestration/Phases.ts)、[PlanPersistence](../src/persistence/PlanPersistence.ts)、阶段类、路由和页面散落产物文件名；产物同步通过创建阶段执行器获取文件列表。 | 统一产物标识、文件名、归属、标签键及只读属性；服务端负责解析物理路径，前端消费可序列化元数据。将 [PhaseHelpers](../src/orchestrator/steps/PhaseHelpers.ts) 的发布接口改成接收产物描述，解除对 `BasePhase` 实例的依赖。 | 展示、下载、审核完整性检查和 Issue 产物同步使用同一描述；保持原产物名称和同步幂等键语义；前端不引入 `node:crypto` 等服务端依赖。 |
| C5 · P3 | [IssueTracker](../src/tracker/IssueTracker.ts) 的 `slice(7)` 和 runner 两端的会话前缀长度属于协议解析重复。 | 统一前缀定义与构造/解析函数，使用 `PREFIX.length`；解析阶段标识时验证合法 `PhaseId`。 | 已持久化的合法标识字符串语义不变；未知前缀或阶段明确拒绝/返回无匹配，不产生伪造的阶段或会话。 |

当前未提交的检查点 UTF-8 JSON 文本化及运行格式 v6 作为本计划基线保留。C1 不重新引入旧格式读取或迁移，也不恢复 Base64 存储。若后续确实修改持久化结构，另行说明格式变更，依照项目约定拒绝旧格式。

## 4. 遗留代码清理表

删除前均需核对源码、脚本、测试、包导出、动态引用及文档；“只有测试引用”说明需要迁移测试职责，不能单凭搜索结果直接删文件。

| 编号 | 清理对象 | 判断与实施顺序 | 验收标准 |
| --- | --- | --- | --- |
| D1 · P2 | `BuildPhase`（已删除）、[PhaseFactory](../src/phases/PhaseFactory.ts)、[UatPhase](../src/phases/UatPhase.ts) 的失效方法 | 主流程 build 已由 DagPhaseRunner 接管，但 [RunWorkflowStep](../src/orchestrator/steps/RunWorkflowStep.ts) 发布阶段仍创建阶段实例。先完成 C4，迁移有效行为测试到 DagPhaseRunner/TaskGraphExecutor，再删除旧 Build 执行路径和无用工厂注册。UAT 只删除确认未使用的提示词入口，保留真实执行与报告判定。 | 正常构建、任务恢复、知识注入、验证修复和产物同步覆盖仍在；不存在为获取元数据而构造旧执行器的路径；真实 UAT 行为不退化。 |
| D2 · P3 | [SupplementStore.toPromptText](../src/supplement/SupplementStore.ts)、`ConflictResolver`（已删除）、`PullRequestHelper`（已删除）、`PlanPersistence.ensureGitignore` | 前者仅见测试调用，实际补充资料走需求上下文生成；旧冲突处理和 PR 文案工具无当前生产调用；ensureGitignore 是空方法。先统一补充资料空白处理并迁移到真实入口测试，再删除孤立方法、工具、模板和只验证空行为的测试。 | 补充资料仍通过真实需求链路进入上下文；删除的工具不再承担任何公开接口；运行路径不依赖 `.claude-plan` 旧目录；保留“不向目标仓库写内部产物”的真实集成断言。 |
| D3 · P2 | `verify:loopStarted` / `verify:iterationComplete` / `verify:loopExhausted` 旧事件链；`shouldDeployServers`、`deploysPreview` 旧预览标记 | 后端没有相应修复事件生产者，前端仍注册和处理；预览实际由进入 UAT 且配置开启时启动。清理旧 EventBus/SSE/页面分支；修复轮次展示直接投影持久化 `repairRounds`、`repairs`。删除失效预览依赖并同步元数据与测试。 | 刷新或重启后修复轮次仍准确；不新增另一份仅靠事件累加的状态；预览开启、关闭、修复后重启、暂停继续均按真实入口工作。 |
| D4 · P3 | 遗留提示词、代码注释、阅读文档和快照 | 随相关模块清理，纠正“生命周期等于图执行位置”、阶段预算写成任务预算、计划可直接编辑、旧目录和 build 自动启动预览等误导描述。 | 描述与原生调用链一致；快照只更新实际变化，历史验收记录不改写成当前行为说明。 |

保留 [AsyncMutex](../src/utils/AsyncMutex.ts)。当前实现较小，已有排队和取消覆盖；换库必须保留“单个等待者取消”的语义，不能以取消整个队列代替。Semaphore 与 ConcurrencyLimiter 分别承担额度和调度约束，不因名字相近而合并。

## 5. 性能及工程约束

| 编号 | 现状判断 | 计划 | 验收标准 |
| --- | --- | --- | --- |
| E1 · P2 | [AgentLogStore](../src/web/AgentLogStore.ts) 每次追加后同步读取并拆分整个日志，超过上限后频繁重写；前后端摘要逻辑重复。性能影响程度尚未量化。 | 采用计数/阈值触发的批量裁剪或轮转，避免每条日志全量扫描。将摘要整理成浏览器可用的纯函数，保留服务端留存与页面窗口各自的容量语义；明确单条内容截断策略。 | 用代表性日志量比较读写次数和延迟；正常追加不逐条全文件读取；超限后容量受控，重启可读；日志优化不改变 Issue 权威状态事务。 |
| E2 · P2 | [DevServerManager](../src/preview/DevServerManager.ts) 固定等待约 10 秒并检查进程存活，不能证明服务已经可用。 | 在现有进程管理上增加有总超时的就绪探测：可配置 HTTP 地址，或使用实际分配端口做 TCP 探测；明确 TCP 只能证明监听，HTTP 判定需符合项目配置。无需所有目标项目新增 `/health`。探测响应取消和子进程退出。 | 覆盖快速就绪、延迟就绪、从未就绪、提前退出、取消，以及实际分配端口。就绪即继续，超时给出原因，取消后无遗留进程。 |
| E3 · P2 | [预览测试](../tests/unit/dev-server-manager.test.ts) 传入不存在的 `healthCheckTimeoutMs`、`healthCheckIntervalMs`；现有 typecheck 不包含 tests，Vitest 通过也无法发现这类类型问题。 | 从批次 0 起登记类型基线；修复每批涉及测试的真实类型错误，增加 tests 类型检查配置。最终将保留测试纳入检查，避免用宽泛断言隐藏失效配置。 | 无效选项能被类型检查拦截；预览测试使用实际生效配置；保留测试能通过新增类型检查和原有运行测试。 |
| E4 · P3 | GitHub 重试窗口和默认值散落；配置、CLI 初始化、页面中也有部分相同语义的默认值。 | 按领域统一同义默认值。GitHub 的 30 秒自动等待上限在错误分类与重试器之间共用定义；持续区分业务限额、默认值和协议常量。 | 需要等待 60 秒的限流仍退出短等待重试，而不是被缩短成 30 秒重发；边界值有覆盖。不同用途的超时、日志上限和端口范围不被强行合并。 |

E4 是可维护性整理。核对结果表明 [ApiError](../src/errors/ApiError.ts) 已将超过 30 秒等待的限流判为不可自动重试，因此不能把它列为“当前会提前重试”的缺陷。

不安排仅以文件行数为依据的大拆分。较大的 IssueService、API 路由只在本次具体职责提取确有收益时局部整理。核心阶段集合、合法端口范围、真实 UAT 使用零自动重试的策略，以及演示夹具中的示例值，不一律改成配置项。

## 6. 后续双图展示

两张图都值得展示，建议放在 Issue 详情页：主流程回答“这个 Issue 当前走到哪里”，任务图回答“本轮 build 的任务如何依赖、执行和合并”。现有任务表保留为详细信息视图。

| 编号 | 展示范围 | 拓扑与状态来源 | 实施要点 |
| --- | --- | --- | --- |
| F1 | Issue 主流程图：plan、review、build、verify、uat、deliver，审核驳回和验证修复回边 | 拓扑来自 [IssueWorkflow](../src/orchestrator/IssueWorkflow.ts) 图定义；执行位置来自对应线程的 checkpoint `next`、任务和 interrupt；业务状态来自 IssueRecord | 业务视图按本轮 `workflow.definition.phaseIds` 展示，关闭 UAT 时省略对应业务阶段。调试视图保留原生图中的 publish 节点及全部声明路由，并区分本轮不会走的路径。`phaseProgress` 用于审计，不据此推算恢复节点。 |
| F2 | build 内部任务 DAG：任务、依赖边、等待、执行、失败、成功待合并、已合并 | 拓扑来自当前不可变计划的 tasks/dependsOn；运行状态来自当前轮 `run.tasks` 及成功、合并凭证 | [TaskGraphExecutor](../src/dag/TaskGraphExecutor.ts) 内图没有 checkpointer。抽出可共用的纯拓扑构造，渲染与执行共用节点/边来源；扩展现有 tasks 接口和 [TaskGraphPanel](../src/web/frontend/src/components/TaskGraphPanel.vue)，避免维护第二套任务调度状态。 |
| F3 | 两图联动、轮次隔离、调试信息，以及业务生命周期说明 | 用 planRevision、buildGeneration、workflow generation 和记录版本识别所属轮次；生命周期依据 [IssueLifecycle](../src/tracker/IssueLifecycle.ts) | 点击主流程 build 展示对应任务图；明确当前入口是任务构建还是 `repair-integration`。生命周期状态机另做中文说明图，可在实施时使用用户 TODO 指定的 Archify；它是业务解释文档，不新增运行引擎。 |

实现分两步：先提供只读拓扑，再叠加运行状态与两图联动。可以利用原生 `getGraphAsync()` / Mermaid 导出能力；抽取图定义时评估可测试性和副作用，查看图形不得调用 `invoke()`、启动 AI、操作 Git 或写入 tracker。渲染方案在展示阶段选定，优先本地完成，不增加外部图形服务依赖。

必须区分以下场景：

1. 正常 build 执行任务 DAG，任务只有完成集成合并后才显示为“已合并”，模型成功不是最终完成凭证。
2. verify/uat 失败后回到 build，当前实现进入集成修复，可以直接调用 AI 修复集成工作区。此时主流程显示 build 正在修复，原任务图保持真实状态，不能把已合并任务重新标成运行中。
3. PR 冲突恢复也可能进入集成修复；页面应显示对应入口及原因，修复后仍更新原 PR。
4. 审核中断、暂停、失败、恢复，以及完整重做后的新轮次都需要准确投影。无检查点或无计划时展示明确空态，不伪造当前位置和任务。
5. 新旧请求乱序返回、计划重新审核、完整重做后，界面拒绝用旧轮次状态覆盖当前图。

验收覆盖：正常串行和分叉汇合、审核等待与驳回、重启恢复、暂停继续、verify/uat 回到 build、PR 冲突修复、禁用 UAT、完整重做及过期响应。单纯请求图数据不得产生执行副作用。

## 7. 用户 TODO 对照表

| TODO 位置 | 判断 | 对应计划 |
| --- | --- | --- |
| `dag/contracts.ts`：版本号去除或全局配置 | 保留存储格式标识，按领域统一定义；不同对象和运行轮次不共享同一个版本号 | C1 |
| `shared/workbench.ts`：草稿版本号 | 与草稿服务共用格式常量，前端只依赖浏览器可用模块 | C1 |
| `TaskGraphExecutor.ts`：`N + 2` 与绘图 | 当前上界探针正常；解释超步边界，展示纳入两图规划 | C2、F1～F3 |
| `TaskGraphExecutor.ts`：内联 prompt | 值得抽出类型化提示词构造；保留完整业务约束 | C3 |
| `TaskGraphExecutor.ts`：冲突修复次数 2 | 统一领域上限与 Codec，优先常量；暂不新增用户配置 | C2 |
| `SupplementStore.ts`：`toPromptText` 未使用 | 当前真实调用已走需求上下文，迁移测试后删除重复路径 | D2 |
| `IssueTracker.ts`：`slice(7)` | 用前缀常量长度和合法阶段解析替代 | C5 |
| `IssueLifecycle.ts`：Archify 状态机图 | 纳入后续业务生命周期说明，区分业务状态与 LangGraph 执行位置 | F3 |
| `AsyncMutex.ts`：是否改用库 | 暂保留；以 FIFO、单等待者取消和释放行为决定是否替换 | 保留结论，相关回归继续运行 |

## 8. 验证和交付要求

此前审查已完成 typecheck，并分别运行了两组相关测试（75 项、71 项）以及若干只读探针。这些结果用于支撑问题判断，不能当作尚未实施修复的验收结果，也不代表完整构建和全量回归通过。首次规划时仅新增计划文档；本次代码修复的验证另见第 9 节。

每一批实际修改后运行 `npm run typecheck` 和受影响测试。全部代码修复交付前按项目约定运行：

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run web:build
npm.cmd test
```

E3 增加的 tests 类型检查同时加入验证。模拟端到端验收与真实 SDK 调用分开报告；原生工作流和恢复集成测试必须保留，必要时运行对应模拟 E2E，不把真实模型调用混入普通回归。

关键保留场景包括：计划只读与完整持久化、驳回携带完整旧计划、审核和阶段副作用幂等、任务成功后恢复仅合并、修复预算跨重启不返还、旧轮次不能写回、取消清理进程树、UAT 拒绝旧报告与无效退出码、同一 PR 交付恢复，以及未知运行格式拒绝加载。

每批交付说明记录：修复条目、实际行为变化、验证命令与结果、尚未覆盖的场景。测试迁移要记录旧场景的新归属，避免用删测试掩盖行为缺失。保持每 Issue 聚合事务、不可变计划、官方 SDK 受管理执行，以及 `orchestration` / `orchestrator` 的现有职责边界。

## 9. 产物名称与路径约定实施记录

用户指定先修复此项，并明确不需要历史数据兼容或特殊判断。具体约定见 [产物文档](artifact-conventions.md)。

- C4：已统一文件名、标签、只读属性和阶段归属；执行、持久化、API、页面及发布共用定义与路径解析。
- D1：已解除发布逻辑对阶段执行器实例的依赖；旧 BuildPhase 的进一步清理仍待实施。
- D2：已删除旧 PR 文案工具、空的 ensureGitignore、审核后备目录与合并接口，并迁移有效测试。SupplementStore 和 ConflictResolver 的清理仍待实施。
- B1：已修正产物降级列表、UAT 报告展示与默认只读；元数据加载失败后的请求重试仍待实施。
- 已删除旧目录读写和特殊 Git 排除规则；审核展示只使用当前聚合记录。提示词和录制回放测试不再使用旧目录。
- 验收完成：typecheck、前后端构建通过；完整保留测试集 104 个文件、871 项通过。测试在正常 Windows 权限下使用本机 Chrome；AI/平台为模拟实现，未执行真实 Codex 或 GitHub 写入。第 8 节的此前测试数字仅为审查历史。

## 10. 本轮落地记录

本轮不添加任何旧格式迁移或历史目录后备路径；保留原有检查点 UTF-8 JSON 与 v6 运行格式。已完成的用户 TODO 已删除或改成结论性说明，辅助说明注释保留。

| 条目 | 已实施行为 | 主要验证归属 |
| --- | --- | --- |
| A1、A2 | CallPolicy 统一完整超时、延期、模型和读写选项；两条蒸馏只读 | build-phase-scenarios、dag-execution、distill 测试 |
| A3 | Verify 不再依赖 checkbox；Lint/Build/Test 任一缺失或失败均不通过 | verify-report-parser、verify-phase-scenarios |
| B1、B2 | 元数据失败后可重新加载且并发合并；固化阶段优先；精确标签归属 | frontend-graph-state、frontend-artifacts、repair-contracts、dag-delivery |
| C1、C2、C5 | 分领域格式、任务/冲突额度、递归上界与标识解析统一 | Codec、current-state-contract、repair-contracts、dag-execution |
| C3 | 提示词纯函数与共用 JSON 提取；驳回恢复会话也携带完整旧计划 | repair-contracts、plan-phase、prompt-templates、distill |
| C4 | 延续上次产物约定，无旧目录兼容 | artifact-paths、审核 API 与完整回归 |
| D1、D2 | 删除旧 BuildPhase、ConflictResolver、孤立补充资料转换及旧模板；UAT 保留真实报告判定 | 旧 Build 有效行为已迁移至真实 DagPhaseRunner；恢复、合并及 UAT 集成测试保留 |
| D3、D4 | 删除无生产者的修复事件和预览标记；修复轮次来自持久化记录；更新阅读文档 | frontend-graph-state、原生恢复与预览测试 |
| E1 | 日志按每 1000 条余量批裁剪；摘要前后端共用、单条最多 2000 字符 | agent-log-retention：已有 20000 条上追加 1000 条，只读全文件 2 次、裁剪 1 次；样本约 410ms，不作为性能 SLA |
| E2 | TCP/可配置 HTTP 就绪探测、总超时和取消；修复启动后立即停止的竞态 | preview-readiness、preview-startup、windows-preview |
| E3 | 所有保留 tests 加入 vue-tsc；修正失效配置、夹具、旧字段和匿名类导出类型 | npm run typecheck 包含 typecheck:tests |
| E4 | GitHub 短等待上限共用；配置、CLI、页面和预览共享同义默认值 | repair-contracts、config、setup 与完整回归 |
| F1～F3 | 只读双图接口；真实 checkpoint 与共用任务拓扑；build 联动、修复入口说明、轮次防乱序 | workflow-graphs、frontend-graph-state、workbench 浏览器验收；[生命周期说明图](issue-lifecycle.md) |

双图额外修复：完整重做时虽然保留历史计划快照，图只展示新轮次聚合记录中的任务，避免把旧计划误显示成当前执行。图接口读取期间若记录变化会重新取样，持续变化返回可重试的 409。

预览配置新增 `PREVIEW_STARTUP_TIMEOUT_MS`（默认 60000）、`PREVIEW_READINESS_INTERVAL_MS`（默认 200）、前后端 `PREVIEW_*_READY_URL`。HTTP 地址支持 `{port}`，留空时探测实际分配端口；TCP 成功只证明端口监听。设置页保存后需重启生效。

测试迁移说明：旧 Build 的候选提交、无变更失败、AI 失败、集成修复与 UAT 准备迁到 `tests/unit/phases/build-phase-scenarios.test.ts` 的真实 DagPhaseRunner；任务依赖/恢复/冲突预算继续由真实 Git 的 `dag-execution` 覆盖；知识注入迁到 `knowledge-feature-switches` 的真实构建入口。仅描述不存在 API 或验证空方法的重复用例已删除；Plan/Verify 的 SDK 会话恢复、完整审核快照和 UAT 原始凭证覆盖保留。

最终验证结果（2026-09-20）：

- `npm run typecheck`：后端、脚本、前端及全部保留测试类型检查通过。
- `npm run build`、`npm run web:build`：通过。
- `IAF_TEST_BROWSER_CHANNEL=chrome npm run test:all -- --silent --reporter=dot`：111 个文件、880 项全部通过，包含 Chrome 工作台端到端、真实临时 Git、取消与进程树清理；耗时约 353 秒。
- `git diff --cached --check`：通过；变更文档的本地链接检查通过。
- 生命周期说明图：Archify showcase 9/9、零错误零警告；四种桌面尺寸无溢出；深浅主题截图复核及搜索、聚焦关闭、SVG 导出验证通过。

AI 与 GitHub 全部使用模拟实现；本轮未调用真实 Codex，也未写入真实 GitHub。第 8、9 节和其他文档中的旧测试数量保留为历史记录，不用于替代本轮验收结果。
