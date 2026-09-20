# Issue 业务生命周期与双图

交互说明图：[Issue 生命周期](issue-lifecycle.html)。图展示常见执行、审核、失败恢复与取消路径；完整事件约束如下。它不参与运行调度。

Issue 详情页的“内部任务”页签同时展示主流程和 build 任务图。主图取自编译后的 `IssueWorkflow.getGraph()`；高亮依据当前线程检查点 `next`，不从 `phaseProgress` 推算恢复位置。调试开关显示 publish 节点、原生声明路由及中断任务；业务图按本轮固化阶段隐藏未启用的 UAT。

build 图与执行器共用 `taskTopology()`。模型返回成功只代表执行成功，显示“已合并”还要求成功及集成凭证。`repair-integration` 入口保留原 DAG 结果并显示本轮修复原因。无当前计划或检查点时显示空态。图接口只读，带记录版本、计划版本、构建轮次、流程代次与线程 ID；页面拒绝旧请求或旧版本覆盖新图。

## 状态转换

唯一业务定义见 [IssueLifecycle.ts](../src/tracker/IssueLifecycle.ts)。下表省略的转换均抛出 `InvalidLifecycleTransitionError`；开始、重试和重做操作还需经过各调用入口的业务校验。

| 事件 | 允许的当前状态 | 目标与约束 |
| --- | --- | --- |
| setup-completed | pending、ready | ready |
| start-requested | skipped | pending |
| phase-started | ready、pending、failed(auto) | running；自动失败必须未绑定阶段或阶段一致 |
| phase-completed | running | ready；阶段必须一致 |
| gate-interrupted | running、waiting | waiting；阶段一致；已有审核版本不得被另一版本覆盖；重复中断保持原状态 |
| gate-resolved | waiting、running | 批准到 ready，驳回到 pending；阶段一致，等待审核时计划版本必须一致 |
| phase-failed | pending、ready、running、failed、delivering | failed；运行时指定的阶段必须一致；保存错误与自动/人工重试类型 |
| pause-requested | pending、ready、running、waiting、failed、delivering | paused；记录待恢复阶段 |
| continue-requested | paused | ready |
| retry-requested | failed | ready；是否具备预算由上层控制 |
| phase-redo-requested | 除 cancelled 外 | ready；重做入口负责代次隔离 |
| delivery-started | ready、running | delivering |
| delivery-confirmed | delivering | completed |
| cancel-requested | 除 completed、cancelled 外 | cancelled |
| full-redo-requested | 所有状态 | pending；创建新的执行轮次 |
| conflict-repair-started | completed | ready；修复原 PR 的冲突 |

`running`、`waiting`、`paused` 的 phase 是业务字段。恢复节点始终从当前 LangGraph 线程读取；同一个业务状态不一定对应一个固定图节点。生命周期图中的正常交付轨道概括主线，不枚举所有全局事件的连线，完整语义以上表与 reducer 为准。

## 生成与验证记录

图由 Archify 生成；源 JSON 为 [issue-lifecycle.lifecycle.json](issue-lifecycle.lifecycle.json)。浏览器证据见 [检查联系表](issue-lifecycle.visual-check.html)。校验和截图绑定同一份 HTML；人工图像复核检查了浅色 1440×900、深色 2048×1320 的文字、连线、留白与卡片布局。

```text
diagram_type: lifecycle
output: E:/Edge_Load/issue-auto-finish/.iaf-mini/worktrees/langgraph-native/docs/issue-lifecycle.html
specification_sha256: 362f369f432661b0ba284e7371f69a2450cd3cf89f5202f0266ea7a02992f68b
artifact_sha256: 3ee429ce235f941504691ec7a5e2aee9c7715e2429240d13a74352ba6f8984a7
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 2
```

自动浏览器检查覆盖 1440×900、1600×1000、1920×1080、2048×1320，均无页面溢出；浅色与深色端点截图已保存在文档目录。

附加本机 Chrome 验证通过：搜索“等待审核”得到唯一节点、聚焦后关闭信息面板、导出 SVG。导出文件为 53730 字节，不含脚本或查找控件；验证对象绑定上述 HTML 哈希。
