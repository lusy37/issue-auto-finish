# Issue Auto-Finish

单用户、单实例、单仓库的 AI Issue 开发工作台，使用 Vue、TypeScript、Express 和本地 JSON。使用 LangGraph 原生工作流管理审核中断、检查点恢复与阶段重试；构建阶段按任务依赖调度。

界面提供任务工作台、需求草稿、知识与经验、任务统计及设置。默认流程为 plan → review → build → verify → uat（浏览器验收可关闭）；成功后交付 PR、回写 Issue 并采集经验。计划统一审核，build 内部任务按依赖执行。

工作流设计与状态约束见 [LangGraph 原生工作流说明](docs/langgraph-native.md) 和 [Issue 生命周期说明](docs/issue-lifecycle.md)。

## 快速演示

需要 Node.js ≥22.12 和 Git；浏览器验收需要安装 Playwright Chromium，使用 Edge 时可设置 `IAF_TEST_BROWSER_CHANNEL=msedge`。依赖版本由 `package-lock.json` 锁定。以下命令在**仓库根目录**执行：

~~~powershell
npm ci
npm run e2e:install
npm run build
npm run web:build
npm run demo
~~~

打开 http://127.0.0.1:3000，在任务工作台手动启动演示 Issue，并在详情中审核计划。此演示使用模拟 GitHub 与 AI，真实执行本地 Git、持久化和浏览器验收；运行数据写入已忽略的 `.iaf-mini/demo-langgraph-v6`。端口冲突时，在启动前设置 `IAF_DEMO_PORT` 和 `IAF_DEMO_PLATFORM_PORT`。

## 多状态界面展示

运行 `npm run demo:showcase`，打开 http://127.0.0.1:3312。独立的 `.iaf-mini/showcase-frontend-v6` 会生成 8 条本地演示任务，覆盖待审核、构建中、暂停、失败、完成、取消等状态及并行任务图；重复启动会保留已有样例。

其中 #308“工作台主题升级”的 DAG 为：准备主题规范 → 前端组件、主题接口、迁移文档（三路并行）→ 集成并联调 → 回归验证。打开 #308 的“实施计划”或“执行视图”，可以看到三个同层节点同时处于“执行中”。

此入口只用于界面验收：后台不轮询、不调度，GitHub 和 AI 均为本地模拟；完成状态和验收报告不代表真实 PR 或测试证据。不要在展示页提交审核、重试或启动任务。需要更换端口时，在启动前设置 `IAF_DEMO_PORT` 与 `IAF_DEMO_PLATFORM_PORT`。

## 连接真实仓库

~~~powershell
npm run init
npm run doctor
~~~

按照 [`env.example`](env.example) 编辑 `.iaf-mini/github/.env`，配置用于处理 Issue 的仓库、Token、本地 Git 克隆目录、基础分支及测试和预览环境。**该业务仓库可以与本项目源码仓库不同**；不要将真实凭据提交到 Git。确保推送认证和 Codex 登录可用后运行 `npm start`，打开设置页检查连接。修改配置后重启服务。

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

浏览器检查默认使用已安装的 Chromium，也支持 `IAF_TEST_BROWSER_CHANNEL=chrome` 或 `msedge`。CI 配置位于 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。`npm run web:build` 如提示单个 JS Bundle 超过 500 KB，这是包体积警告，不代表构建失败；首屏性能优化应优先按页面拆分代码。

本次整理的本机检查：类型检查、后端 Lint、前后端构建及相关的 61 项测试通过；完整保留测试集 **859 项通过、9 项失败**。失败涉及 Windows 进程回收、测试进程内存不足和两项工作流断言，尚未解决，不能视为完整回归通过。真实 Codex 调用与模拟回归分开验证。

## 数据与 Git

默认配置、任务、日志和 worktree 均位于当前项目 .iaf-mini/github 下。IAF_MINI_HOME 可统一替换根目录，也支持 DATA_DIR、LOGS_DIR、WORKTREE_BASE_DIR 分别显式配置。运行数据和凭据已忽略，不导入 mini 项目的任务数据。

Native 聚合运行状态使用 `iaf-mini/issue-run/v6-langgraph`，不可变计划与草稿分别使用独立格式。项目仍处于开发阶段，不提供旧聚合格式的适配或迁移；启动遇到非 v6、损坏文件或缺失计划引用会报告具体路径并停止调度。更改模型后使用新的 `DATA_DIR` 或清空确认不再需要的开发数据，且不要删除仍有进程使用的工作目录。

暂停／取消先保存停止意图并等待进程退出；不确定的孤儿进程保持目录隔离。普通重试复用已确认任务，完整重做使用新构建轮次但保留原 PR。开放 PR 继续更新，关闭 PR 需先重开，已合并 PR 对应的 Issue 不再重做。详细状态和恢复规则见 [DAG 实施记录](docs/dag-implementation.md)。

业务 Issue 使用独立 worktree 和分支，通过 PR 交付；完成后不会自动合并。历史实施和验收记录保留在 [文档目录](docs/)，不作为当前版本的测试结果。运行数据与源码分离，不要读取或修改原 `data/` 作为工作台运行数据。
