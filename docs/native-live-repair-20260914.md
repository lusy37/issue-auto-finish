# LangGraph native 真实 UAT 失败修复闭环（2026-09-14）

真实 GitHub Issue 经正常轮询进入工作台，完成只读规划、浏览器审核、首次开发和 verify；正式 Chrome UAT 检出 3 项断言失败后，LangGraph 自动进入一次集成修复，再次 verify 和相同的 8 项浏览器测试全部通过，最终自动创建 PR。审核通过后没有人工重试、修改任务状态或代写业务修复。

本例是明确标注的受控故障注入，用来保证真实执行失败修复路径；不是自然发生的缺陷。正常需求从零开发、三任务 DAG 和首次 UAT 通过的独立证据见 [正常闭环报告](native-live-uat-20260914.md)。两组均使用真实 GitHub、官方 Codex SDK、受管理 worker、Git 和 Chrome，没有模拟 AI 或平台。

## 验收对象与隔离

- 受检分支：`codex/langgraph-native`，基于 `d51c26145e2377eb0f94ec133695092f18243764`，包含此前未提交的精简和三项业务修复。运行已构建的 `dist/run.js`。
- 原沙箱：`E:/Edge_Load/issue-auto-finish-sandbox`，远端 `lusy37/issue-auto-finish-sandbox`。原沙箱工作目录保持干净，本地及远端 main 均保持 `616696f56e6be3019d13b9ea7db6a8ce2b460d7b`。
- 本次独立检出、工作目录、数据、端口和证据在 native 工作树的 `.iaf-mini/native-repair-20260914-0525/`，未复用上一用例的任务记录。
- 故障基线分支：`codex/native-uat-repair-base-20260914`，提交 `622dd06d0bfc0d1f7f4022262f63392a894a3002`。预置取反按钮及 8 项浏览器测试，但故意让 `negateCount(2)` 返回 `Math.abs(2)`，结果为 `2`。独立探针已证实错误存在。
- [Issue #9](https://github.com/lusy37/issue-auto-finish-sandbox/issues/9)，交付为 [PR #10](https://github.com/lusy37/issue-auto-finish-sandbox/pull/10)。PR 目标是故障基线分支，保持打开、未合并；不将故障夹具合入 main。

为了确保失败发生在正式 UAT，本次批准的初始计划只有一个“登记演练说明”的文档任务；明确要求首轮保留故障，正式 UAT 报告传入集成修复入口后才允许修复函数和追加单元测试。因此，本例验证的是工作台的自动修复机制，不能用于衡量模型首次实现需求的正确率。

## 实测链路

以下时间均为北京时间。

| 环节 | 实际结果 |
| --- | --- |
| GitHub 入口 | 服务先完成首次存量扫描，再新建带 `auto-finish` 标签的 Issue；正常轮询发现并执行，没有直接调用任务启动 API 替代入口。 |
| plan / review | 第 1 版完整计划持久化；审核前 HEAD 等于故障基线且工作目录无改动。真实 Chrome 刷新后保持审核门禁，build 未启动。验收代理阅读完整计划后点击通过并接受确认框。 |
| 首轮 build / verify | 唯一初始任务仅新增演练说明并合并，提交为 `950be0d5d0328ee0f1759f0e7f4ead78f85bf6a7`。真实 verify 执行 lint、build、原有 3 项单元测试，均通过。 |
| 首轮正式 UAT | 13:59:59 开始，运行 `41903f15-a636-4841-ba19-e90d29c68356`。结果为 5 通过、3 失败、0 跳过，分类为 `assertion`；关键断言期望 `-2`，实际 `2`。本次生成有效 JSON、HTML 报告及失败截图。 |
| 自动回退 | 14:00:27，持久化图结果记录 `phase=uat, outcome=retried-from, next=build`；`buildEntry=repair-integration`。初始任务保持已合并、仅执行 1 次，没有重跑任务图。 |
| 真实修复 | 新的受管理 Codex 会话读取失败报告，先追加单元测试并复现 4 项失败，再将函数修复为 `current === 0 ? 0 : -current`。保留原有 3 项测试，追加 7 项，覆盖正负数、正负零、安全整数边界、非法输入和连续操作。 |
| 第二轮 verify | lint、build、10 项单元测试通过。修复只涉及函数、关联单元测试和演练文档；候选提交为 `50281844f09207f9c682fae159899c8e8ea9c412`。 |
| 第二轮正式 UAT | 日志证实先停止旧预览、释放端口，再启动预览；14:06:23 执行运行 `d3c92afd-3a6c-416b-b0a3-b321265ce2ee`，8 通过、0 失败、0 跳过、0 不稳定重试，Playwright 报告用时约 8.2 秒。 |
| 自动交付 | 14:06:51 完成。创建唯一 PR 和带交付标记的唯一 Issue 评论，设置 `auto-finish:done`，采集一条成功日记。 |

最终 `build=2、verify=2、uat=2、repairRounds=1`；真实 SDK 共 5 次会话：规划 1 次、初始任务 1 次、集成修复 1 次、verify 2 次。所有受管理调用最终均退出。

## 防止假通过的核对

两轮正式浏览器测试和配置保持相同内容，最终文件 SHA-256 与故障夹具一致：

| 冻结文件 | SHA-256 |
| --- | --- |
| `tests/e2e/counter.spec.ts` | `d06e19eeb0a94dc014130c44f22064dafafcbbe20aa65a539a2400a9c4f4931f` |
| `playwright.config.ts` | `5ad532f428e253ee3aec2271f3f1000374e8aacde2ebfda7a7c6990c708b43c8` |

验收代理读取了原始两轮报告，并通过真实 Chrome 打开两份 HTML 报告、检查截图和页面异常。首轮失败确为计数值错误，第二轮全部通过；没有删除、跳过或弱化浏览器断言。额外直接导入最终函数，独立验证正负数、正负零、安全整数边界和非法输入语义。

修复凭证的 `before` 等于初始任务的成功提交，`after` 等于最终候选；任务身份为 `$phase:build` 的第 2 次调用。最终本地 HEAD、远端分支、PR head、verify、UAT 和推送凭证均绑定 `50281844f09207f9c682fae159899c8e8ea9c412`，交付后工作目录干净。

## 重启、收尾与边界

交付后停止并重启本次真实服务，完成状态、计划版本、阶段计数、修复计数、图结果、副作用和交付凭证均保持一致；SDK 会话仍为 5 次，成功日记仍为 1 条，PR 和交付评论仍各 1 条。再次停止后，服务和启动器已退出，49672、22501、23501 端口均可重新绑定。

本次验收代理没有修改工作台产品代码。工作区在运行期间发生一处 `src/run.ts` 注释编辑：180 个源码文件中 179 个字节级一致，剩余文件已用与基线哈希匹配的原文进行 TypeScript 转译对比，去除注释后的 JavaScript 完全一致，原改动予以保留。`source-comparison.json` 记录具体哈希，不将此次报告写成“全部源码字节相同”。

验收完成及服务停止之后，工作区又补充了 `src/index.ts` 的启动步骤注释。最终核对为 178 个文件字节一致、2 个文件仅注释变化，去除注释后的转译结果均与基线相同；运行用的 `dist/run.js` 和 `dist/index.js` 修改时间仍早于本次服务启动。此后续对比单独保存在 `post-acceptance-source-check.json`，不覆盖验收时的快照。

证据脚本曾因页面同时展示两轮同名报告链接而出现选择器歧义，改为按成功运行编号精确定位后通过；收尾脚本也调整为从实际端口分配日志读取已被产品清理的端口字段。这些调整仅涉及验收辅助脚本，发生于业务已完成之后，没有重新运行业务或改变正式 UAT 结果。

本例覆盖真实 UAT 断言失败后的集成修复与预览重启，不覆盖所有取消竞争、任务合并冲突、并行 DAG 或回收目录后的完整重做。此前 1025 项回归及构建属于独立验证证据，不计入本次真实浏览器或 SDK 数量。

## 证据位置

- [机器可读摘要](evidence/native-live-repair-20260914.json)。
- 独立运行目录：`.iaf-mini/native-repair-20260914-0525/`。
- 核心记录：`fixture-proof.json`、`issue-request.json`、`issue.json`、`plan-readonly.json`、`approval.json`、`acceptance.json`、`final-record.json`、`repair-proof.json`、`source-comparison.json`、`restart-proof.json`、`diary-and-sdk-proof.json`、`cleanup.json`、`service.log`。
- 截图：`review-after-refresh.png`、`completed-workbench.png`、`first-uat-failure.png`、`formal-uat-report.png`。
- 两轮正式报告分别位于 `data/uat/41903f15-a636-4841-ba19-e90d29c68356/` 和 `data/uat/d3c92afd-3a6c-416b-b0a3-b321265ce2ee/`，包含 `summary.json`、`results.json` 和 `report/index.html`。
- 配置凭据仅在本次被 Git 忽略的运行目录中，不进入文档和摘要。
