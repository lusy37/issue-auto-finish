# Issue Auto-Finish

单用户、单实例、单仓库的 AI Issue 开发工作台。以 issue-auto-finish-mini 为功能参考，从可启动骨架分批接入成熟模块、测试和界面，形成可回溯的 main 线性提交历史。

六个入口：任务工作台、需求拆分、知识与经验、蒸馏、任务统计、设置。固定流程为 plan → review → build → verify → uat，通过后推送业务分支、创建或复用 PR、回写 Issue 并采集经验。

## 快速演示

需要 Node.js ≥22.12、Git 和可用浏览器。本次验收使用 Windows、Chrome；依赖版本由 package-lock.json 锁定。

~~~powershell
cd E:\Edge_Load\issue-auto-finish
npm ci
npm run e2e:install
npm run build
npm run web:build
npm run demo
~~~

打开 http://127.0.0.1:3000，在任务工作台手动启动演示 Issue，打开详情查看计划并审核通过。演示使用模拟 GitHub 与 AI，Git、状态持久化和浏览器验收真实执行；数据写入 .iaf-mini/demo-github。使用本机 Chrome 时先设置 $env:IAF_TEST_BROWSER_CHANNEL='chrome'。

## 连接真实仓库

~~~powershell
npm run init
npm run doctor
~~~

按照 env.example 编辑 .iaf-mini/github/.env，配置专用仓库、Token、本地 Git 克隆目录、main 基础分支、测试及预览环境；确保 Git 推送认证和 Codex 登录可用。然后执行 npm start，打开设置页检查平台连接。修改设置后重启服务。

Codex 使用官方 SDK 与内置原生程序；CODEX_BINARY 留空即可，模型留空沿用用户配置。计划调用只读，完整计划由服务端持久化。真实调用检查为 npm run test:codex，独立于模拟回归，可能产生模型用量。

新增带 auto-finish 标签的 Issue 可被轮询发现；启动服务前已有的 Issue 首轮标为跳过，需在工作台手动启动。审核驳回会把上次计划和反馈带入新一轮规划，通过后才开始实现。

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

浏览器检查默认使用已安装的 Chromium，也支持 IAF_TEST_BROWSER_CHANNEL=chrome。Windows CI 已配置在 .github/workflows/ci.yml；远程 CI 尚未触发，本次结果来自本机执行。

## 数据与 Git

默认配置、任务、日志和 worktree 均位于当前项目 .iaf-mini/github 下。IAF_MINI_HOME 可统一替换根目录，也支持 DATA_DIR、LOGS_DIR、WORKTREE_BASE_DIR 分别显式配置。运行数据和凭据已忽略，不导入 mini 项目的任务数据。

工程开发在 main 上按功能提交，2026-09-05 至 2026-09-11 对应七个开发阶段，日期按指定学习日程回排，不使用 Git 阶段标签。业务任务使用独立 worktree 和分支，通过 PR 交付；完成后不自动合并。此工程的 Git 历史保存在本地，专用测试仓库的 Issue/PR 是独立验收产物。

本次完整回归 925 项通过，另通过 Chrome 工作台端到端、Windows 专项和真实 Codex 检查。真实流程产物：[Issue #3](https://github.com/lusy37/issue-auto-finish-sandbox/issues/3)、[PR #4](https://github.com/lusy37/issue-auto-finish-sandbox/pull/4)。

详细说明：[开发记录](docs/development.md)、[架构与功能对照](docs/architecture.md)、[精简依据](docs/simplification.md)、[验收记录](docs/validation.md)。
