# LangGraph native 真实独立闭环验收（2026-09-14）

真实 GitHub Issue → 正常轮询发现 → Codex 规划 → 浏览器审核 → 三任务 DAG 开发 → verify → 正式 Chrome UAT → GitHub PR 交付已完成。正式 UAT 为 8 项通过、0 失败、0 跳过、0 不稳定重试；重启后没有重复执行或交付。

本次存在一次依赖安装超时及服务退出，验收代理恢复服务并通过正式中止、继续入口核验孤儿调用后继续同一 Issue。业务代码首次验收通过，`repairRounds = 0`，因此本次不能作为“真实 UAT 失败后由 Codex 自动修复”的验证证据，也不表述为全程无人干预。

后续已另建独立故障用例，完成真实 UAT 失败、自动集成修复及同一测试复验通过，见 [失败修复闭环报告](native-live-repair-20260914.md)。该补充结果与本报告分别留存，不改变本次首次通过的历史记录。

## 对象与隔离范围

- 受检分支：`codex/langgraph-native`，基于 `d51c26145e2377eb0f94ec133695092f18243764`，包含此前未提交的精简和三项业务修复。重新构建后以 `dist/run.js` 启动；验收前后 180 个源码文件的 SHA-256 一致，本次没有修改产品源码。
- 实际沙箱：`E:/Edge_Load/issue-auto-finish-sandbox`。用户给出的 `E:/Edge/_Load/issue-auto-finish-sandbox` 不存在，使用唯一匹配的实际目录及其 GitHub 远端。
- 独立检出、数据、工作目录、端口及证据位于 native 工作树的 `.iaf-mini/native-live-20260914-0300/`；没有读取旧任务记录作为本次运行状态。项目知识配置沿用已有沙箱配置。
- 基线：`616696f56e6be3019d13b9ea7db6a8ce2b460d7b`。原沙箱工作目录干净，原沙箱 main 与 GitHub main 均保持该提交。
- [Issue #7](https://github.com/lusy37/issue-auto-finish-sandbox/issues/7)：计数器增加取反操作并覆盖负数边界。
- [PR #8](https://github.com/lusy37/issue-auto-finish-sandbox/pull/8)：分支 `codex/native-uat-20260914-7`，提交 `43e6e7fffd6cdd0d731d5743e7f93d0c3af2dbb6`，PR 保持打开、未合并。

## 实测结果

| 环节 | 结果和证据 |
| --- | --- |
| GitHub 入口 | 先启动正常服务并完成首次存量扫描，再通过真实 GitHub API 新建带 `auto-finish` 标签的 Issue。日志记录发现、跟踪及驱动，没有直接调用 `processIssue()` 或启动任务 API 来替代轮询。 |
| 真实 AI | 官方 Codex SDK 经受管理 worker 发起 5 次会话：plan 1 次、内部任务 3 次、verify 1 次。没有模拟 AI 或平台。 |
| 审核 | 完整计划持久化为第 1 版；真实 Chrome 刷新后仍等待审核且 build 尚未启动。验收代理阅读计划后在工作台点击通过计划并接受确认框，未启用自动审核。 |
| 任务图 | `task1 → task2 → task3` 按依赖执行，三个任务各执行一次，均取得成功及合并凭证。原有计算及浏览器测试保留。 |
| verify | 真实 Codex 执行 lint、build 和单元测试；报告记录三条命令退出码均为 0，27 项单元测试通过。正式 UAT 由后续独立阶段执行，不以 verify 中的模型文字代替其判定。 |
| 正式 UAT | 运行 `48b9867d-40fd-4f22-b200-49d30cfa318b`；2026-09-14 13:13:14（北京时间）开始，Playwright 报告用时约 13.9 秒。8 项通过，失败、跳过、不稳定重试均为 0，并生成本次 JSON、HTML 报告及截图。 |
| 提交一致性 | 本地 HEAD、远端分支、PR head、verify 凭证、UAT 凭证、推送凭证均为同一候选提交。交付后工作目录干净。 |
| 平台回写 | 工作台自动创建唯一 PR、唯一带交付标记的 Issue 评论，并设置 `auto-finish:done`；成功经验日记只有一条。 |
| 工作台展示 | 真实 Chrome 打开完成详情及本次 HTML 报告，截图中显示 8 项通过；页面脚本异常为 0。 |
| 重启恢复 | 停止并重启本次真实服务，完成状态、阶段执行次数、计划版本、验收与交付凭证、图结果及副作用记录一致；SDK 会话仍为 5 次，PR 与交付评论仍各一条。 |
| 收尾 | 本次服务及启动器已退出，57537、22401、23401 端口可重新绑定。保留工作目录、PR 和报告供复查。 |

## 中断处置与验证边界

第一次运行在工作目录建立后的依赖安装阶段出现命令超时，尚未发起 Codex 调用，随后原服务退出。恢复时仍存在未确认退出的旧调用记录，普通重试 API 返回 409，要求先中止并核验进程。验收代理确认没有残留工作台调用后，通过正式 `/abort` 和 `/continue` 接口恢复，未直接编辑运行 JSON 或伪造阶段结果。独立检出中的依赖安装复查正常，约 2 秒完成。

该过程验证了同一任务的显式恢复入口，但不是 UAT 断言失败后的集成修复。浏览器自动化首次点击审核时未处理原生确认框，框架默认取消，因此没有提交审核；补齐测试脚本的对话框处理后完成审核，产品代码未修改。

本次覆盖的是一个真实需求及三任务串行依赖图，不覆盖所有并行调度、冲突、取消时机或 UAT 自动修复故障分支。此前 1025 项模拟/本地回归属于另一组证据，本次没有把它们计入真实验收结果。

## 证据位置

- [机器可读摘要](evidence/native-live-uat-20260914.json)。
- 独立运行目录：`.iaf-mini/native-live-20260914-0300/`。
- 原始记录：`run.json`、`issue-request.json`、`issue.json`、`review-pending.json`、`approval.json`、`acceptance.json`、`final-record.json`、`interventions.jsonl`、`restart-proof.json`、`diary-and-sdk-proof.json`、`cleanup.json`、`service.log`。
- 截图：`review-after-refresh.png`、`review-approved.png`、`completed-workbench.png`、`formal-uat-report.png`。
- 正式报告：`data/uat/48b9867d-40fd-4f22-b200-49d30cfa318b/report/index.html`，原始结果为相邻 `results.json` 与 `summary.json`。
- 配置凭据只保存在被 Git 忽略的本次运行目录，不写入文档和摘要。
