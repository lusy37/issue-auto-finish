# 当前状态契约与兼容清理

日期：2026-09-17。范围：main、codex/langgraph-native。

## 复核结论

项目没有正式用户数据，因此不为缺失关键字段的记录自动补值或猜测执行位置。但未初始化任务、当前流程的重启恢复、业务历史与展示投影仍是现有功能。

Native 已删除 StateAdapter 与 TrackerStateStore，不能套用 main 的调用关系；pipelineMode 在轮询发现任务后、执行器初始化前可以为空，不是历史兼容。E2E 也不需要增加同义布尔字段，但 Native 已将本轮阶段列表固化到 `run.workflow.definition.phaseIds`，不再从 `phaseProgress` 推断配置。

## 实际调整

- main 继续直接读取其已保存的 orchestrationState；Native 不复用这套内部状态驱动器。
- Native v4 只持久化 `IssueLifecycle`，启动时拒绝缺失、未知 kind 或缺少必要字段的记录；`state`、`currentPhase` 和 `orchestrationState` 仅作为旧 REST/事件兼容投影生成。
- Native 的执行位置只由 LangGraph 检查点决定，业务生命周期只负责调度、人工介入和交付边界。
- 删除重复的 e2eEnabled 记录字段及旧记录回退；Native 已初始化任务由不可变 workflow definition 是否包含 uat 决定验收要求，仅尚未初始化时读取全局配置。
- Native 不再读写 `progress.json`；阶段审计、会话恢复和页面详情统一读取聚合记录中的 `phaseProgress`。
- Native 的 Zod 校验集中在 I/O/框架 Codec，跨字段规则使用普通 invariant 函数；旧 v3 数据不自动迁移。
- 生命周期查找保留新任务的 plan-mode 默认值；显式未知模式或默认流程未注册时抛错，不再选择任意一个已注册管理器。

## 保留边界

不删除存储格式校验、原子写入、调用身份校验、暂停取消、重启恢复、审核和修复历史、候选提交验收凭证或交付防重。不读取或修改原 data/，不迁移测试运行目录，不修改旧验收记录。

初始化是当前业务入口，不等同于读取时的数据迁移；phaseHistory 等字段在清空历史后仍可缺省。业务 IssueState 与编排投影也不是可逆的一对一关系，不能用删除整套映射替代明确的状态所有权。

## 验证范围

新增回归覆盖全部当前业务状态的写入恢复、缺失和损坏快照拒绝且原文件不变、未知模式拒绝。保留并调整 E2E 开关、审核重启、关闭验收后交付及 Native 检查点恢复测试。自动回归的 AI 与 GitHub 响应仍使用模拟，真实本地 Git 和浏览器检查单独由对应测试执行，不代表重新调用真实 Codex 或完成外部 GitHub 验收。
