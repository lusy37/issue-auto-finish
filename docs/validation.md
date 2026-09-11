# 本次验收记录

日期：2026-09-12（北京时间）。受检工程：E:\Edge_Load\issue-auto-finish。代码提交：0c70606b5673536e084cc5e575b22a3a054d8794。参考 mini 项目没有被修改。

## 工程检查

| 检查 | 本次结果 |
| --- | --- |
| npm run typecheck | 通过：服务端、脚本和 Vue |
| npm test | 925 项通过；包含保留的单元、集成、契约、快照、架构及调用序列测试 |
| npm run build | 通过：服务端与类型声明 |
| npm run web:build | 通过：Vue/Vite 生产构建 |
| npm run test:e2e | 通过：真实 Chrome，六入口、草稿编辑创建、审核刷新、统计与报告截图；平台与 AI 为模拟 |
| npm run test:windows | 通过：中文空格目录、.cmd 启动、超时取消、进程树清理及两个预览端口释放 |
| npm run test:codex | 通过：独立真实 SDK 调用，在新建中文空格目录生成文件并由宿主再次运行测试 |

Windows 专项在 Windows 实机执行，非跳过结果。各增量命令、执行耗时与时间保存在 [工程证据](evidence/engineering.json)；最终日志位于 .iaf-mini/rebuild-validation/22/。Chrome 工作台截图和本次报告位于 .iaf-mini/browser-tests/。

阶段回归曾遇到 Git 初始化、Windows 清理及并行工作进程超时；同时发现原架构约束未容纳共享纯类型。修复架构检查的共享类型边界及重复解析开销，把真实 Git 初始化钩子上限从 10 秒调整为 30 秒、完整 Git/浏览器流程从 90 秒调整为 180 秒，保留所有行为断言。受影响的 27 项测试串行复验通过，随后完整复验通过。真实 SDK 首次 120 秒 smoke 超时，尽管文件生成及独立测试通过，该次仍记录为失败；随后独立 300 秒上限复验在约 58 秒通过，最终正式 npm run test:codex 另有结果。失败与成功记录均保留。

## 真实 GitHub 与 Codex

- Issue：[专用测试任务 #3](https://github.com/lusy37/issue-auto-finish-sandbox/issues/3)。
- PR：[feat(#3): 重实现验收 d2760461：计数器增加重置按钮](https://github.com/lusy37/issue-auto-finish-sandbox/pull/4)，保持打开供查看。
- 分支：feat/issue-3；提交：29651fb7aa74ef88f54a3dc5cc9f51ec4beaafe2。
- 流程：只读计划 → 持久化并等待审核 → 审核通过 → 构建 → verify → 本次 Playwright UAT → 推送 → PR → Issue 结果及完成标签回写 → 经验采集。
- UAT：runId 为 1e1e9cb2-5f5c-4ccf-8412-9abddc454af9，8 项通过，0 项失败；本次报告有效。报告目录：.iaf-mini/live/data/uat/1e1e9cb2-5f5c-4ccf-8412-9abddc454af9/。
- 重启核对：真实已完成任务、PR 地址和持久化统计重新加载一致；详见 [真实证据](evidence/live.json)。

真实构建首次遇到 SDK SSE 连接空闲超时，工作台记录失败后恢复同一会话，第二次执行完成；统计保留 1 次重试。build/verify 的本地 Playwright 自检遇到 Windows 服务收尾停滞，由 Codex 核实并关闭其本次启动的服务后获得退出码 0；工作台正式 UAT 则由统一进程工具和预览管理器独立执行，8 项通过后预览进程退出、端口释放。

真实联调在第六阶段功能就绪后启动；后续共享类型精简、并发启动修复和演示进程调整分别进行了回归。证据中的 inspectionCommit 表示核验时工程提交，restartedCodeCommit 表示最终重启核对的代码提交，不将核验时间等同于服务最初启动时间。

联调使用独立 .iaf-mini/live 配置、克隆、worktree 和任务数据。未将 mini 的旧任务作为验收结果，未自动合并 PR。真实平台访问、Codex 调用、正式 UAT 与模拟回归分别记录。

## 故障覆盖

保留正常闭环、审核驳回、重复触发、验证失败回构建、修复上限、取消、超时、重启恢复、交付失败重试、PR 复用、草稿创建结果未知、蒸馏失败等场景。新增并发启动 HTTP 测试验证相同编号只创建一次，平台查询失败后可重试。

原始运行数据包含本机路径和日志，位于已忽略的 .iaf-mini；提交的 evidence 文件只包含核验所需摘要，配置令牌不纳入 Git。Windows CI 文件已准备，本地工程未推送远程，不能把本机结果称为远程 CI 通过。
