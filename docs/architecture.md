# 架构与功能对照

Vue 与 TypeScript 负责工作台，Express 暴露 HTTP 与 SSE，本地 JSON 原子持久化。Codex SDK 和 GitHub REST 客户端分别承担 AI 执行与平台访问，运行边界保持单用户、单实例、单仓库。

| 模块 | 职责与边界 | 主要验证 |
| --- | --- | --- |
| src/config-schema.ts、cli、paths | 配置校验、环境检查、独立数据目录 | config、settings-api、paths、instance-lock |
| clients、demand/adapters | GitHub 查询、标签、Issue/PR/回写，平台需求归一 | github-client、demand-adapter |
| tracker、persistence | 任务状态、完整计划、审核历史、原子写入 | issue-tracker、plan-persistence、review-history |
| workspace、git、utils/process.ts | 独立 worktree、Git、取消与 Windows 进程树 | workspace、git-operations、windows-preview |
| orchestration | 状态、意图、纯状态转换 | transition、contracts、phase-intents |
| orchestrator、phases | 执行调用和副作用，plan/review/build/verify/uat | orchestrator、recovery、completion、gate |
| ai-runner | 官方 SDK 适配、日志、超时、会话恢复；保留 AIRunner 接口 | codex-runner、独立 test:codex |
| e2e、deploy | 预览端口、真实 Playwright 与本次有效报告 | uat、preview、Windows 专项 |
| demand/DraftService | AI 拆分、草稿编辑确认、创建防重与未知结果核对 | mini-features、drafts、workbench |
| knowledge、distill | 规则启停、日记、手动蒸馏与版本，失败不影响已交付任务 | knowledge、distill、diary |
| analytics | 从持久化任务计算统计 | mini-features、workbench、真实重启核对 |
| web | 六入口、设置、流式日志、计划差异与报告 | web-api、plan-diff-api、workbench |

服务端 pipeline/PipelineDefinition.ts 提供阶段元数据，前端通过 /api/pipeline-meta 使用同一来源。前后端共用 src/shared/workbench.ts 中的草稿、状态、UAT 和统计契约；保留现有 API 路径及 SSE 事件名称。

计划阶段只读，审核通过是构建门禁；驳回需要上次计划与反馈并再次审核。verify 失败携带原因返回 build，修复次数有限。取消、超时和服务重启通过持久化状态及会话恢复处理。交付只在本次 UAT 退出成功且报告有效时执行，创建或复用 PR，结果回写有幂等标记。

知识注入只读取启用规则。经验采集与蒸馏属于交付后的附加步骤，不把蒸馏失败变成开发任务失败。统计从持久化记录计算，因此服务重启不重置累计结果。

参考项目仅剩两个无调用的聚合导出文件和一个引用已移除阶段的无调用测试工厂未带入；所有实际测试文件及快照均保留。具体精简见 [记录](simplification.md)。
