# LangGraph Native 前端重构计划

## 计划信息

| 项目 | 内容 |
| --- | --- |
| 目标分支 | `codex/langgraph-native-frontend-refactor` |
| 基线分支 | `codex/langgraph-native` |
| 基线提交 | `b67cea5` |
| 目标原型 | `native-ui-production`，本地预览地址：`http://127.0.0.1:5176/#/workbench` |
| 适用范围 | `src/web/frontend` 的工作台、Issue 详情、任务 DAG、审核、日志、UAT 和辅助页面 |
| 后端策略 | 保持 LangGraph Native 服务端契约不变，前端通过适配层接入现有 REST API 与 SSE |
| 组件策略 | 延续 Vue 3 + TypeScript，优先使用现有组件和成熟组件模式，避免手写整套视觉组件 |
| 数据原则 | `IssueLifecycle`、`IssueRun`、`IssueGraphs` 和服务端事件是唯一事实来源，页面不维护第二套业务状态 |

## 重构目标

把原型中的工作台信息架构落到真实前端，使以下内容能够直接展示真实数据并执行真实操作：

- Issue 队列、筛选、统计、阶段进度和生命周期状态。
- Plan、Review、Build、Verify、UAT、Deliver 的阶段历史与当前准入条件。
- Build 阶段任务 DAG、依赖关系、任务执行状态、失败信息和验收标准。
- Agent 日志、系统日志、SSE 推送和刷新后的状态收敛。
- 计划版本、审核反馈、驳回原因、重试和人工继续。
- UAT 运行记录、候选提交、退出码、报告有效性和历史结果。
- 草稿、知识、蒸馏、分析、设置等辅助页面的真实读写边界。

重构期间保留服务端对状态、审核门禁、重试额度、图轮次和 UAT 结果的控制。前端只负责呈现服务端事实和发起已授权操作。

## 设计与交互基线

设计以当前原型为视觉基线，采用适合开发运维工作台的高信息密度布局，同时遵循 UI/UX Pro Max 的通用要求：

- 所有可操作控件保持可见焦点、可用键盘完成操作，并具有明确的 `aria-label` 或语义名称。
- 状态徽标同时提供文字和语义色，不能只依赖颜色表达成功、失败或等待。
- API 操作显示提交中、成功和失败反馈，避免点击后无反馈。
- 表格、日志和 DAG 在 375px、768px、1024px、1440px 宽度下不产生整页横向溢出。
- DAG 保留服务端提供的节点和边，Dagre/Vue Flow 只负责布局和交互，不在浏览器端重新拆分任务或改写依赖。
- 深色主题保持正文对比度和焦点可见性，动画支持 reduced motion，长列表和日志按需渲染。
- 页面路由、Issue 查询参数和浏览器返回行为可预测，刷新后能够恢复当前上下文。

## 原型到真实前端的映射

| 原型模块 | 真实落点 | 接入内容 |
| --- | --- | --- |
| `WorkbenchShell` | `WorkbenchPage.vue`、`HeaderBar.vue` | 顶部导航、系统状态、主题和页面布局 |
| `TaskTable` | `IssueTable.vue`、`StatsCards.vue` | `GET /api/tasks`、Issue 状态、筛选和统计 |
| `IssueDetail` | `IssueDetailPage.vue`、`PipelineProgress.vue` | `GET /api/issues/:number`、阶段历史和操作准入 |
| `ExecutionGraph` / `TaskNode` | `TaskGraphPanel.vue`、`ExecutionGraph.vue` | `GET /api/issues/:number/graphs`、Vue Flow/DAG 布局 |
| `LogPanel` | `AgentLogViewer.vue`、详情日志区域 | `GET /api/issues/:number/logs` 与 `agent:output` |
| `ReviewPanel` | `ReviewGatePanel.vue`、`PlanDocViewer.vue` | 计划版本、审核门禁、批准和驳回 |
| `DraftEditor` | `DraftsPanel.vue`、`SupplementEditor.vue` | 草稿、补充说明和字段校验 |
| UAT 区域 | `E2eArtifactsViewer.vue` | `GET /api/issues/:number/uat-runs` 和报告历史 |
| Secondary Pages | `KnowledgePanel.vue`、`DistillPanel.vue`、`AnalyticsPanel.vue`、`SettingsPanel.vue` | 复用现有 API，逐页替换演示数据 |

## 执行计划表

估时以一个熟悉当前代码的开发者为基准，按依赖顺序执行。每个阶段完成后单独提交，提交正文记录验证命令和结果。

| 阶段 | 目标 | 主要工作 | 主要文件 | 验收标准 | 估时 | 状态 |
| --- | --- | --- | --- | --- | ---: | --- |
| 0. 基线冻结 | 固定原型和真实契约 | 记录原型截图、读取 `IssueRecord`/`IssueGraphs`/`UatRun` 字段；建立页面状态清单 | `docs/frontend-refactor-plan.md`、`src/web/frontend/src/types` | `npm run typecheck`、`npm run web:build` 通过；基线截图可复现 | 0.5 天 | 已完成 |
| 1. 视图模型适配层 | 消除组件对 mock 类型的依赖 | 已新增真实任务到工作台行模型、状态摘要和生命周期操作适配器；Issue 详情、日志和 UAT 的专用模型仍按后续页面接入 | `src/web/frontend/src/adapters/issueflowViewModel.ts`、`tests/unit/frontend-view-model.test.ts` | 任务字段保留、进度摘要和生命周期操作有契约测试 | 1 天 | 部分完成 |
| 2. 数据访问与缓存 | 接入只读真实数据 | 图数据、UAT 数据统一经 `api/client.ts` 访问；`useTasks` 增加请求序号、加载、错误和搜索状态；图请求继续校验 Issue 与版本 | `src/web/frontend/src/composables/`、`src/web/frontend/src/api/` | 工作台、DAG、UAT 刷新使用真实 API；旧响应不会覆盖新视图 | 1 天 | 部分完成 |
| 3. 工作台壳与队列 | 落地原型首页 | 已落地侧栏导航、顶部状态栏、统计卡片、状态筛选、搜索、空/错/加载状态和响应式布局；详情路由与辅助页沿用现有入口 | `WorkbenchPage.vue`、`HeaderBar.vue`、`IssueTable.vue`、`StatsCards.vue`、`style.css` | 1440px/375px 浏览器加载无横向溢出，console 无错误 | 1 天 | 已完成 |
| 4. Issue 详情与阶段时间线 | 展示服务端生命周期 | 详情页已增加真实加载/失败反馈，操作按钮读取生命周期适配器；阶段进度、历史和 `run` 沿用 Native 真实数据 | `IssueDetailPage.vue`、`useIssueDetail.ts`、`PipelineProgress.vue` | 详情加载失败可见；操作入口与生命周期一致；详情页响应式布局通过浏览器检查 | 1.5 天 | 部分完成 |
| 5. DAG 与任务详情 | 接入真实任务拆分结果 | 已统一深色执行区、图状态栏、刷新反馈和任务表样式；节点/边仍完全来自 `IssueGraphs`，Vue Flow 替换和大图性能优化后续处理 | `TaskGraphPanel.vue`、`ExecutionGraph.vue`、`useIssueGraphs.ts` | 真实图请求、版本保护和任务字段回归通过 | 1.5 天 | 部分完成 |
| 6. 审核、补充和计划文档 | 接通人工门禁 | 接入计划版本、计划差异、审核历史、补充说明；批准/驳回请求携带服务端要求的 revision 和反馈 | `ReviewGatePanel.vue`、`PlanDocViewer.vue`、`SupplementEditor.vue` | 驳回必须有反馈；批准前显示当前版本；旧计划不会覆盖新版本；审核后详情自动刷新 | 1 天 | 待开始 |
| 7. 操作闭环 | 接通真实写操作 | 接入 start、retry、cancel、restart、abort、continue、redo-phase、retry-from-phase、preview 操作；统一 loading、成功、错误和重复点击保护 | `useAction.ts`、`IssueDetailPage.vue`、`StartDialog.vue` | 每个按钮只在合法生命周期出现；服务端错误可见；操作后由 API/SSE 收敛状态 | 1.5 天 | 待开始 |
| 8. SSE 与日志实时化 | 接入连续事件流 | `useSSE` 已覆盖 Native 暂停、阶段、流水线和 UAT 事件；增加事件签名去重与指数退避重连；工作台和详情页按 Issue 收敛刷新 | `useSSE.ts`、`useAgentLogs.ts`、`AgentLogViewer.vue`、`WorkbenchPage.vue`、`IssueDetailPage.vue` | 重复事件不会重复触发刷新；断线可恢复；切换 Issue 后旧事件不污染新详情；日志自动跟随可关闭 | 1 天 | 部分完成 |
| 9. UAT、辅助页面与设置 | 补齐原型其余页面 | UAT 查询已统一经 `api/client.ts`；知识、蒸馏、分析和设置页仍需按原型视觉和真实接口继续收口 | `E2eArtifactsViewer.vue`、`KnowledgePanel.vue`、`DistillPanel.vue`、`AnalyticsPanel.vue`、`SettingsPanel.vue` | UAT 记录来自真实接口；辅助页完成后再做统一验收 | 1.5 天 | 部分完成 |
| 10. 体验和性能收口 | 达到可交付质量 | 检查无障碍、深色主题、响应式、错误文案、懒加载、图表性能和 Naive UI vendor chunk；必要时拆分路由 | `style.css`、各页面和 Vite 配置 | Lighthouse/Playwright 关键项通过；无整页横向溢出；大日志/DAG 不明显卡顿 | 1 天 | 待开始 |
| 11. 灰度切换与交付 | 替换旧页面 | 保留旧页面可回退入口；以真实 Native 数据完成一轮浏览器验收；更新开发文档 | `App.vue`、路由入口、`docs/` | 前后端构建、相关测试、Playwright UAT 通过；当前退出码和本次报告有效 | 1 天 | 待开始 |

预计实施量约 12 个工作日。阶段 1、2、4、5 是核心依赖，必须先完成后再批量接入写操作。

## 数据与接口接入清单

### 首批只读接口

- `GET /api/tasks`
- `GET /api/issues/:number`
- `GET /api/issues/:number/logs`
- `GET /api/issues/:number/graphs`
- `GET /api/issues/:number/tasks`
- `GET /api/issues/:number/review-history`
- `GET /api/issues/:number/plan-diff`
- `GET /api/issues/:number/uat-runs`
- `GET /api/system/status`

### 第二批写接口

- `POST /api/issues/:number/start`
- `POST /api/issues/:number/retry`
- `POST /api/issues/:number/cancel`
- `POST /api/issues/:number/restart`
- `POST /api/issues/:number/abort`
- `POST /api/issues/:number/continue`
- `POST /api/issues/:number/redo-phase`
- `POST /api/issues/:number/retry-from-phase`
- `POST /api/issues/:number/approve-plan`
- `POST /api/issues/:number/reject-plan`
- `POST /api/issues/:number/skip-review`
- `PUT /api/issues/:number/plans/:filename`
- `PUT /api/issues/:number/supplement`
- `PUT /api/issues/:number/note-sync`

### SSE 事件

统一使用 `/api/events`，至少处理：

- `issue:*`：刷新列表和详情摘要。
- `gate:*`：刷新审核状态、计划版本和可用操作。
- `agent:output`：追加 Agent 日志。
- `pipeline:progress`：刷新阶段进度、系统日志和任务图。

## 建议的适配器接口

适配器集中处理服务端模型到 UI 模型的转换，组件不得直接拼接生命周期规则：

```ts
export function toWorkbenchRow(record: IssueRecord): WorkbenchRow;
export function toIssueDetail(record: IssueRecord, meta: PipelineMeta): IssueDetailViewModel;
export function toGraphModel(graphs: IssueGraphs): GraphModel;
export function toLogEntries(entries: AgentLogEntry[]): LogEntry[];
export function toVerificationSummary(runs: UatRun[]): VerificationSummary;
export function getAllowedActions(record: IssueRecord, meta: PipelineMeta): AllowedAction[];
```

`getAllowedActions` 只读取服务端返回的生命周期、阶段历史、重试额度、审核门禁和预览状态；页面文案不能反向推导业务准入。

## 测试和交付门禁

每个阶段至少执行相关的快速检查，合并前执行完整门禁：

```powershell
npm run typecheck
npm run lint
npm run web:build
npm test -- --maxWorkers=1
npm run test:e2e
npm run test:windows
```

前端重构新增测试分为三层：

1. 适配器契约测试：使用真实 Native JSON 夹具验证字段映射、未知状态拒绝和版本保护。
2. 组件交互测试：验证筛选、键盘导航、审核反馈、错误恢复、图节点选择和响应式布局。
3. 浏览器集成测试：使用模拟平台和本地后端验证 API、SSE、操作闭环和刷新恢复。

真实 Codex、真实 GitHub 和模拟平台的结果必须分开记录；UAT 以本次 Playwright 退出码和本次生成的有效报告为准，不复用旧报告或模型文字声明。

## 风险与处理

| 风险 | 影响 | 处理方式 |
| --- | --- | --- |
| 原型状态与 Native 生命周期不一致 | 错误显示或出现非法按钮 | 统一经过适配器和 `getAllowedActions`，服务端状态优先 |
| SSE 事件迟到或重复 | 旧数据覆盖新状态、日志重复 | 使用 Issue/版本/请求序号校验，事件去重并支持重连 |
| DAG 规模或日志过大 | 页面卡顿 | 图布局按需计算，节点详情懒加载，日志窗口化或分页 |
| 计划审核版本冲突 | 错误批准旧计划 | 请求携带当前 `planRevision`，冲突时刷新并要求重新确认 |
| Naive UI vendor 包体积偏大 | 首屏加载变慢 | 首轮接入后分析构建产物，再做路由级拆分和按需加载 |
| 旧页面切换影响现有用户 | 回退困难 | 保留灰度入口，先接只读，再接写操作，最后切换默认入口 |

## 当前执行状态

- [x] 创建 `codex/langgraph-native-frontend-refactor` 子分支。
- [x] 固定原型地址、真实前端入口和 Native 数据契约。
- [x] 完成阶段拆分、接口清单、适配器边界和验收门禁设计。
- [x] 实现工作台任务视图模型适配层。
- [x] 接入工作台、图和 UAT 的第一批真实只读 API。
- [x] 完成工作台壳、统计、任务表和执行图第一批视觉重构。
- [x] 补齐 Issue 详情的加载/失败反馈和生命周期操作准入。
- [ ] 补齐日志和 UAT 的专用视图适配层。
- [x] 完成 SSE 事件白名单、重复过滤和退避重连第一批收敛。
- [ ] 接入审核、重试、暂停和 UAT 操作。
- [ ] 完成前后端构建及浏览器验收。
