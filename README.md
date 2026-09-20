# Issue Auto-Finish

单用户、单实例、单仓库的 AI Issue 开发工作台。以 issue-auto-finish-mini 为功能参考，从可启动骨架分批接入成熟模块、测试和界面，形成可回溯的 main 线性提交历史。

六个入口：任务工作台、需求草稿、知识与经验、蒸馏、任务统计、设置。默认流程为 plan → review → build → verify → uat（浏览器验收可关闭）。一个草稿创建一个 Issue；计划包含 1～20 个内部任务，统一审核后在 build 中按依赖并行执行，汇总后绑定同一提交完成验证和浏览器验收，最后更新该 Issue 唯一的 PR、回写 Issue 并采集经验。

当前分支使用 LangGraph 原生工作流，详见 [迁移说明与学习入口](docs/langgraph-native.md)。审核中断、检查点恢复、节点重试和 build 内的依赖调度由框架负责。

## 快速演示

需要 Node.js ≥22.12 和 Git；启用浏览器验收时还需可用浏览器。本轮 DAG 验收使用 Windows、Edge；依赖版本由 package-lock.json 锁定。

~~~powershell
cd E:\Edge_Load\issue-auto-finish\.iaf-mini\worktrees\langgraph-native
npm ci
npm run e2e:install
npm run build
npm run web:build
npm run demo
~~~

打开 http://127.0.0.1:3000，在任务工作台手动启动演示 Issue，打开详情查看计划并审核通过。演示使用模拟 GitHub 与 AI，Git、状态持久化和浏览器验收真实执行；数据写入 .iaf-mini/demo-langgraph-v6。同时保留其他演示实例时，分别设置 `IAF_DEMO_PORT` 和 `IAF_DEMO_PLATFORM_PORT` 为未占用端口；端口冲突会报错停止。使用本机 Edge 时先设置 $env:IAF_TEST_BROWSER_CHANNEL='msedge'。

## 连接真实仓库

~~~powershell
npm run init
npm run doctor
~~~

按照 env.example 编辑 .iaf-mini/github/.env，配置专用仓库、Token、本地 Git 克隆目录、main 基础分支、测试及预览环境；确保 Git 推送认证和 Codex 登录可用。然后执行 npm start，打开设置页检查平台连接。修改设置后重启服务。

Codex 使用官方 SDK 与内置原生程序；CODEX_BINARY 留空即可，模型留空沿用用户配置。计划调用只读，完整计划由服务端持久化。真实调用检查为 npm run test:codex，独立于模拟回归，可能产生模型用量。

新增带 auto-finish 标签的 Issue 可被轮询发现；启动服务前已有的 Issue 首轮标为跳过，需在工作台手动启动。审核驳回会把上次计划和反馈带入新一轮规划，通过后才开始实现。

## 流程与知识设置

Web 工作台固定开启，无关闭开关。设置页提供以下选项，保存后**重启服务生效**；运行中的任务不会因保存配置立即改变行为。

| 设置 | 默认 | 关闭或修改后的行为 |
| --- | --- | --- |
| 父 Issue 并发 | 1 | 正整数，限制同时处理的父需求数量 |
| 全局 AI 并发额度 | 4 | 范围 1～32，限制全部官方 SDK 调用；排队中的调用可取消 |
| 普通自动重试次数 | 3 | 首次执行之外的次数，0 不自动重试；暂停、重启、普通重试不返还额度 |
| 启用浏览器验收（E2E） | 开启 | 关闭后 verify 通过即可进入交付，明确注明浏览器验收未启用；已有流程保持初始化时的要求 |
| 启用计划审核 | 开启 | 新进入审核节点的完整计划保存后按配置自动通过；已有待审任务仍等待明确操作 |
| 任务引用知识与经验 | 开启 | 停止给新 AI 请求附加项目知识、经验规则；资料管理、安装及构建测试命令仍可用 |
| 启用经验蒸馏 | 开启 | 禁止新的手动蒸馏，保留原有日记、知识和历史；日记采集继续 |
| 验证失败后自动修复 | 开启 | verify 或有效 UAT 断言失败后停止，保留报告，等待人工处理 |
| 最大自动修复轮数 | 3 | 范围 1～10，表示verify 与有效 UAT 断言失败共用的集成修复轮数；重启继续累计已有次数 |

知识引用与蒸馏互相独立。旧 `WEB_ENABLED=true` 会提示清理；`false` 会明确报错，请删除该配置。演示模式重启会保留上述流程设置，平台、仓库和 AI 仍固定使用本地演示配置。

设置 `KNOWLEDGE_PATH` 时，启动、项目资料页面及 AI 使用同一文件；只编辑表单字段不会清空其他资料。显式文件缺失或损坏会报错，默认位置首次缺失则允许创建。知识、补充资料和配置保存使用原子文件替换；正文与索引仍是两个文件，不承诺跨文件一起回滚。实现与验证记录见 [修复计划](docs/config-knowledge-storage-repair-plan.md)。

设置页可开关浏览器验收，或配置 `E2E_UI_ENABLED=false`。保存后重启，新任务和完整重做采用新设置；暂停继续、普通重试及已有审核中的任务保留本轮原要求。预览服务独立配置，详见 [E2E 开关说明](docs/e2e-toggle.md)。

## 开发与检查

~~~powershell
npm run dev:all
# 完整检查
npm run typecheck
npm test
npm run build
npm run web:build
npm run test:e2e
npm run test:windows
# 独立真实 Codex 检查
npm run test:codex
~~~

浏览器检查默认使用已安装的 Chromium，也支持 IAF_TEST_BROWSER_CHANNEL=chrome 或 msedge。Windows CI 已配置在 .github/workflows/ci.yml；远程 CI 尚未触发，本次结果来自本机执行。

## 数据与 Git

默认配置、任务、日志和 worktree 均位于当前项目 .iaf-mini/github 下。IAF_MINI_HOME 可统一替换根目录，也支持 DATA_DIR、LOGS_DIR、WORKTREE_BASE_DIR 分别显式配置。运行数据和凭据已忽略，不导入 mini 项目的任务数据。

Native 聚合运行状态使用 `iaf-mini/issue-run/v6-langgraph`，不可变计划与草稿分别使用独立格式。项目仍处于开发阶段，不提供旧聚合格式的适配或迁移；启动遇到非 v6、损坏文件或缺失计划引用会报告具体路径并停止调度。更改模型后使用新的 `DATA_DIR` 或清空确认不再需要的开发数据，且不要删除仍有进程使用的工作目录。

暂停／取消先保存停止意图并等待进程退出；不确定的孤儿进程保持目录隔离。普通重试复用已确认任务，完整重做使用新构建轮次但保留原 PR。开放 PR 继续更新，关闭 PR 需先重开，已合并 PR 对应的 Issue 不再重做。详细状态和恢复规则见 [DAG 实施记录](docs/dag-implementation.md)。

工程开发在 main 上按功能提交，2026-09-05 至 2026-09-11 对应七个开发阶段，日期按指定学习日程回排，不使用 Git 阶段标签。业务任务使用独立 worktree 和分支，通过 PR 交付；完成后不自动合并。此工程的 Git 历史保存在本地，专用测试仓库的 Issue/PR 是独立验收产物。

初次实现验收的完整回归 925 项通过，另通过 Chrome 工作台端到端、Windows 专项和真实 Codex 检查。真实流程产物：[Issue #3](https://github.com/lusy37/issue-auto-finish-sandbox/issues/3)、[PR #4](https://github.com/lusy37/issue-auto-finish-sandbox/pull/4)。

底层依赖迁移后，Windows 本机完整回归 **937 项通过**，类型检查、前后端构建、Chrome 工作台端到端及 Windows 专项均通过。本次未复跑真实 Codex/GitHub 验收。相关源码与脚本净减少 138 行，见 [迁移记录](docs/dependency-migration.md)。

遗留兼容清理后，本机完整回归 **924 项通过**，类型检查、前后端构建和 Chrome 工作台验收通过。删除范围、保留依据及测试数量变化见 [兼容代码盘点](docs/compatibility-audit.md)。

详细说明：[开发记录](docs/development.md)、[架构与功能对照](docs/architecture.md)、[精简依据](docs/simplification.md)、[验收记录](docs/validation.md)。

精简后已再次执行真实 GitHub、Codex 和 Windows Chrome 全流程：[Issue #5](https://github.com/lusy37/issue-auto-finish-sandbox/issues/5) → [PR #6](https://github.com/lusy37/issue-auto-finish-sandbox/pull/6)，正式 UAT 7 项通过，重启核对通过。旧 mini 实例重复领取造成的标签干扰及恢复处置见 [本次真实复验记录](docs/live-uat-20260912.md)。

配置、知识读写和文件保存修复后，Windows 本机回归 **958 项通过**，类型检查、前后端构建、变更文件 lint 和 Chrome 工作台端到端通过。本轮 AI/GitHub 使用模拟，未重新调用真实服务。行为说明、统计及验证边界见 [修复实施记录](docs/config-knowledge-storage-repair-plan.md#七实施与验收结果)。

单 Issue 内部 DAG 修订完成后，本机完整回归 **1005 项通过**，工作台 Edge 端到端、类型检查、变更文件 lint 和前后端构建均通过。真实 Codex 生成代码与中止验证单独通过；本轮 GitHub 使用模拟平台，独立演示使用真实 Git 与 Edge 完成唯一 PR 交付。新状态格式、恢复边界、配置和实际增删见 [DAG 实施记录](docs/dag-implementation.md)。

Issue 详情的“内部任务”页签提供主流程与 build 任务双图，支持查看检查点和集成修复入口。参见 [双图与生命周期说明](docs/issue-lifecycle.md) 和 [修复实施记录](docs/langgraph-native-repair-plan.md)。

2026-09-20 审查计划落地：完整保留测试 111 个文件、880 项通过（含 Chrome 工作台验收），类型检查与前后端构建通过。本轮 AI/GitHub 使用模拟实现，未执行真实 Codex 或平台写入。
