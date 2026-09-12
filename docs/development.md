# 重实现开发记录

main 按功能线性提交。根据指定的学习日程，提交日期回排为 2026-09-05 至 2026-09-11，按日期区分 Day0 至 Day6，不设置 Git 阶段标签；测试和真实验收保留原始发生时间。

| 计划里程碑 | 对应提交 | 交付与检查 |
| --- | --- | --- |
| Day0 | 5b8a8df | 工程、配置、CLI、六入口骨架与设置；类型、当期测试、前后端构建通过 |
| Day1 | 4686f3d | GitHub、任务存储、工作区契约及统一 Git 进程；当期回归和构建通过 |
| Day2 | fa5a509 | SDK、计划、审核、主流程及实时详情；564 项回归和构建通过 |
| Day3 | 4cff134 | 取消、有限重试、会话恢复和重启恢复；646 项回归和构建通过 |
| Day4 | aceb87e | UAT、PR 防重、交付故障恢复；673 项回归和构建通过 |
| Day5 | ec414b1 | 需求、知识、蒸馏、统计和完整演示；727 项回归和构建通过 |
| Day6 | 本文提交 / main | 925 项完整回归、前后端构建、浏览器、Windows 和真实 Issue → PR 验收通过 |

阶段基础类型和调用依赖按编译依赖先后接入，因此 build、verify、UAT 的基础层在完整主流程工作台之前提交；恢复、交付和六入口的行为分别以随后增量测试验收。所有代码增量都先类型检查与当期测试，再查看差异并提交，里程碑另执行前后端构建。

后续开发保持：一个可解释增量一个提交；提交正文记录原因与验证命令；功能变更与独立精简分开；已落地问题用后续 fix 提交调整。通过 git show fa5a509 或 git diff 4686f3d..fa5a509 可查看阶段产物。

检查原始日志位于 .iaf-mini/rebuild-validation/，随运行生成且不提交；可共享的命令、时间、结果摘要纳入 [engineering.json](evidence/engineering.json)，真实交付证据纳入 [live.json](evidence/live.json)。最终受检代码提交为 0c70606b5673536e084cc5e575b22a3a054d8794，本次仅补充文档。

逐条日期、新旧提交号和查看命令见 [提交日程](git-timeline.md)。

## 已完成提交

以下记录截至本次文档提交的父提交；最新提交使用 git log 查看。

~~~text
0384673 chore: 初始化工程与检查脚本
c1dc752 feat(config): 实现配置和环境检查
5b8a8df feat(web): 搭建工作台框架与设置页
f5d3a6b feat(github): 接入 Issue 查询与平台适配
56b2c8e feat(task): 实现任务存储与工作台队列
4686f3d feat(workspace): 实现工作区隔离与统一 Git 进程
a1096e0 feat(ai): 接入 Codex SDK 与执行日志
0b4e897 feat(plan): 实现计划持久化与审核历史
08010e9 feat(plan): 实现只读规划与反馈上下文
521eadc feat(build): 实现构建与项目上下文注入
25b8c03 feat(verify): 实现验证与修复意图
fb21127 feat(uat): 实现真实浏览器验收与预览管理
fa5a509 feat(workbench): 接通主流程与实时审核工作台
4cff134 test(recovery): 覆盖取消重试与会话恢复
aceb87e test(delivery): 验证交付防重与失败恢复闭环
51ba3a5 feat(demand): 接入需求拆分与草稿工作台
87a5422 feat(knowledge): 完善知识规则与经验版本管理
ec414b1 feat(analytics): 完成蒸馏统计与六入口演示
334fafc refactor: 精简共享契约和无调用的过渡代码
47cc277 fix(task): 阻止同一 Issue 的并发重复启动
99f0f48 test: 补齐保留回归与 Windows 持续集成
0c70606 refactor(demo): 统一演示脚本的 Git 子进程调用
~~~

## 后续改进：底层依赖迁移（实际开发日期 2026-09-12）

| 提交 | 实现 | 验证 |
| --- | --- | --- |
| 8d06997 | Execa、which 统一进程和程序查找，预览/开发脚本共用入口，Node ≥22.12 | 类型检查、构建、相关 41 项行为测试 |
| d2852b1 | atomically 统一已有原子 JSON 写入，保留同步保存与失败诊断 | 类型检查、前后端构建、存储 66 项与完整 937 项回归 |

最终 Chrome 工作台端到端和 Windows 专项也通过，详情见 [底层迁移记录](dependency-migration.md)。不新增阶段标签，不将本次本机模拟验证记为真实 Codex/GitHub 复验。
