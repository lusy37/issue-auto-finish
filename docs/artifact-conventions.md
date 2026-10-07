# 产物名称与存储约定

适用分支：`codex/langgraph-native`。更新日期：2026-09-20。

文件名、中文标签、只读属性及阶段归属统一定义在 [shared/runtime/artifacts.ts](../src/shared/runtime/artifacts.ts)。阶段校验、产物发布、API 和页面均使用该定义；本次保留现有文件名及文档 URL。共享运行模块放在 shared/runtime，架构测试禁止其依赖 Node、第三方包或服务端实现；shared 下其他契约仍只包含类型。

| 标识 | 文件名 | 用途与事实来源 |
| --- | --- | --- |
| plan | `01-plan.md` | 实施计划的只读展示；真实运行读取不可变 `plans/<revision>.json` 并渲染 |
| verifyReport | `02-verify-report.md` | 工作台保存本轮真实命令凭证，AI 分析校验通过后追加解释；报告文字不能作为通过凭证 |
| uatReport | `03-uat-report.md` | 浏览器验收报告，由服务端根据准备检查或本次 Playwright 结果生成；检查未通过时明确说明未启动验收 |
| reviewFeedback | `review-feedback.md` | 审核反馈展示，从聚合记录的 reviewHistory 渲染 |
| reviewHistory | `review-history.json` | 审核历史展示，读取同一聚合记录，保留完整计划快照 |
| issueMeta | `issue-meta.json` | Issue 元信息，非阶段发布文档 |
| uatRun | `uat-run.json` | 本次浏览器验收凭证，非阶段发布文档 |

产物物理目录为 `DATA_DIR/issues/<编号>/artifacts/`。使用 [ArtifactPaths.ts](../src/persistence/ArtifactPaths.ts) 解析目录与文件路径；读写跟随当前 Issue 存储实例的数据目录，不从 worktree 路径推导。显式数据目录可以包含中文和空格。

视觉用例清单另存于 `DATA_DIR/issues/<编号>/uat/visual-cases.json`，记录当前批准计划的场景、必需视口和验收引用，属于运行数据而非阶段产物或通过凭证。UAT 准备的 agent 调用仅额外授权该文件的父目录，服务端拒绝链接目录；构建收尾与验收启动前复用同一文件校验。关闭视觉复核时不要求清单，也不授予额外目录权限。

[PlanPersistence](../src/persistence/PlanPersistence.ts) 的 `planDir` 表示产物目录，`baseDir` 表示项目执行工作目录。`artifactPath(filename)` 只接受单个文件名。真实运行构造 PlanPersistence 时传入 tracker 和同一 dataDir。

计划和审核历史的权威内容分别在不可变计划文件和 Issue 聚合记录中。Verify 的权威判定来自工作台本轮受管理进程执行 Lint、Build、Test 的真实退出码，三项都为 0 才能通过。只读 Agent 返回的 `iaf-mini/verify/v1` JSON 必须与本轮命令、退出码、状态一致，服务端替换检查内容为机器凭证后推进状态；Markdown 文件只用于前端展示。即使工作树不存在，API 仍可生成展示内容；不读取审核历史或反馈的文件副本作为后备。阶段发布直接接收产物元数据，无需构造阶段执行器。UAT 仍依据本次退出码和有效报告，Markdown 文件不是通过凭证。

页面元数据不可用时，使用共享产物定义生成只读列表，并按本轮阶段定义决定是否展示 UAT 报告。国际化文案由各语言字典提供。

已删除旧产物路径、审核后备目录及合并 API、旧文件回退、空的 ensureGitignore 方法和无生产调用的 PR 文案工具。Git 只排除当前工作台运行目录，不对旧目录做特殊判断。相关测试改为覆盖真实保存隔离、聚合审核事务、多轮反馈、完整快照、重启恢复和 Issue 隔离。

会话录制与回放工具使用 `artifact-write` 事件，只记录单个文件名。调用方显式传入本次 Issue 的产物目录；回放文件时缺少目录会报错，不写入模型的 workDir。录制回放夹具不代表模型负责计划落盘。

依照用户要求，不增加历史数据兼容、特殊处理或自动迁移。本次未修改运行格式号。其他待实施事项见 [修复计划](langgraph-native-repair-plan.md)。

验收结果：`npm run typecheck`、`npm run lint`、后端构建及前端构建通过；Verify 契约和阶段回归全部通过。完整 `npm test` 共执行 111 个测试文件，107 个文件通过；剩余 4 个文件的 6 个失败来自当前环境缺少 Playwright Chromium、Windows 进程树清理超时及目标项目运行时差异，未涉及 Verify 契约。AI 和 GitHub 使用模拟实现，未调用真实 Codex 或写入远程平台。
