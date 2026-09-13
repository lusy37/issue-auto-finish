# 项目开发约定

本项目是单用户、单实例、单仓库的 AI Issue 开发工作台，使用 Vue、TypeScript、Express 和本地 JSON。开发沟通、新增注释与文档使用中文。

- 核心阶段为 plan、review、build、verify、uat，成功后执行交付和经验采集。
- `orchestration` 负责状态、意图和纯状态转换；`orchestrator` 负责调用和副作用，两者均保留。
- 计划阶段只读，服务端持久化完整计划。审核驳回必须携带上次计划与反馈。
- Codex 通过官方 SDK 执行，禁止重建 CLI 参数和 JSONL 解析层；其他子进程使用 `src/utils/process.ts`；Windows 的 `.cmd`、空格路径、超时取消统一处理。
- UAT 必须根据本次 Playwright 退出码和有效报告判定，不能接受模型文字声明或旧报告。
- 数据只写 `.iaf-mini/` 或显式配置的新目录，禁止读取、修改原 `data/` 作为运行数据。
- 不引入多租户、多仓调度、自动发布、远程知识同步。
- GitHub REST API 已接入。自动回归使用模拟平台；本地演示代码在 `scripts/demo.ts`，不参与真实执行器选择。

修改后运行 `npm run typecheck`、相关测试；交付前执行前后端构建和保留测试集。真实 Codex 调用必须与模拟验证分开报告。

- 允许 build 阶段内部调度单 Issue 的 DAG；所有 SDK 调用通过受管理 worker 和全局 AI 额度，统一进程树生命周期。任务状态采用每 Issue 聚合事务与不可变计划，旧格式不得自动迁移。
