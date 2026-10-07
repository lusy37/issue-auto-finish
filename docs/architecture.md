# 架构与功能对照

Vue 与 TypeScript 负责工作台，Express 暴露 HTTP 与 SSE，本地 JSON 原子持久化。Codex SDK 和 GitHub REST 客户端分别承担 AI 执行与平台访问，运行边界保持单用户、单实例、单仓库。

| 模块 | 职责与边界 | 主要验证 |
| --- | --- | --- |
| src/config-schema.ts、cli、paths | 配置校验、环境检查、独立数据目录 | config、settings-api、paths、instance-lock |
| clients、demand/adapters | GitHub 查询、标签、Issue/PR/回写，平台需求归一 | github-client、demand-adapter |
| tracker、dag/IssueRunStore | 唯一业务生命周期、业务凭证和检查点聚合事务 | issue-tracker、current-state-contract、dag-state |
| persistence | 计划文档、审核历史和报告产物；不维护第二份阶段状态 | plan-persistence、review-history、session-resume |
| workspace、git、utils/process.ts | 独立 worktree、Git、取消与 Windows 进程树 | workspace、git-operations、windows-preview |
| orchestration、dag/codecs | 阶段结果、检查点数据契约和边界解码；跨字段规则使用普通 invariant | native-codecs、contracts、dag-state |
| orchestrator、phases | LangGraph 原生工作流、持久化适配、阶段执行与副作用 | langgraph-native、mini-workflow、审核 API |
| ai-runner | 官方 SDK 适配、日志、超时、会话恢复；保留 AIRunner 接口 | codex-runner、独立 test:codex |
| e2e、preview | 预览端口、真实 Playwright 与本次有效报告 | uat、preview、Windows 专项 |
| demand/DraftService | AI 拆分、草稿编辑确认、创建防重与未知结果核对 | mini-features、drafts、workbench |
| knowledge、distill | 规则启停、日记、手动蒸馏与版本，失败不影响已交付任务 | knowledge、distill、diary |
| analytics | 从持久化任务计算统计 | mini-features、workbench、真实重启核对 |
| web | 六入口、设置、流式日志、计划差异与报告 | web-api、plan-diff-api、workbench |

服务端 pipeline/PipelineMetadata.ts 提供阶段元数据，前端通过 /api/pipeline-meta 使用同一来源。前后端共用 src/shared/workbench.ts 中的生命周期、草稿、UAT 和统计契约；保留现有 API 路径及 SSE 事件名称。

Native 的状态所有权分成三类：LangGraph checkpoint 保存执行位置，`IssueLifecycle` 保存并直接暴露业务生命周期，任务/调用/验收/交付结构保存业务凭证。页面动作和文字由生命周期做无状态投影；`phaseProgress` 只保存审计和会话信息，不参与图路由或 E2E 配置判断。

计划阶段只读，审核通过是构建门禁；驳回需要上次计划与反馈并再次审核。verify 的命令由工作台受管理进程执行，允许被 Git 忽略的缓存和构建产物写入；执行前后校验待交付文件、HEAD 和暂存区未变，发现变化则停止并要求人工检查。AI 保持只读，只分析本轮命令凭证，其检查字段必须与真实退出码一致；每轮新建验证会话，不复用旧结论。verify 失败携带原因返回 build，修复次数有限。取消、超时和服务重启通过持久化状态及会话恢复处理。交付只在本次 UAT 退出成功且报告有效时执行，创建或复用 PR，结果回写有幂等标记。

知识注入只读取启用规则。经验采集与蒸馏属于交付后的附加步骤，不把蒸馏失败变成开发任务失败。统计从持久化记录计算，因此服务重启不重置累计结果。

UAT 准备由 e2e/UatPreparation 统一负责文件契约和最小目录授权。构建收尾先检查配置、清单格式、计划摘要、场景编号、视口和验收引用；不完整时调用 workspace-write 的准备 AI，仅通过官方 SDK additionalDirectories 开放当前 Issue 的 UAT 目录，并再次检查实际落盘内容。启动 Playwright 前复用该校验；准备失败归为环境问题，保存本轮失败报告而不启动验收、不消耗业务修复轮次。视觉复核保持只读。Verify 的源码保护是进程执行前后内容校验，不能视为测试进程的操作系统级只读隔离。

参考项目仅剩两个无调用的聚合导出文件和一个引用已移除阶段的无调用测试工厂未带入；所有实际测试文件及快照均保留。具体精简见 [记录](simplification.md)。

本分支的原生图及新数据格式说明见 [LangGraph 迁移](langgraph-native.md)。旧引擎及其参考测试已经删除，不参与当前实现与测试统计。
