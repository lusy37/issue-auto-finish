# 基础设施简化落地记录

本轮按六项方案落地，以现有业务约束作为替换边界。所有测试运行数据和日志保存于 `.iaf-mini/infrastructure-simplification/`，没有迁移旧运行数据。验收阶段尚未提交代码，也没有发布。

## 已实施的替换

| 范围 | 实现 | 保留的业务约束 |
| --- | --- | --- |
| GitHub HTTP | Octokit REST、分页、retry、throttling；p-limit 限制实际 fetch 并发 | 并发 4；POST 不自动重发；限流等待超过 30 秒交回业务层；分页最多 100 页；平台结构映射和交付防重 |
| 普通进程 | Execa 的 timeout、cancelSignal、killDescendants 和完成等待 | Issue 进程登记；输出尾部截断；回调异常即停止；退出后才完成取消；Windows 中文空格路径和 .cmd |
| SDK 输出 | Zod 生成计划、VERIFY 和记忆/规则蒸馏 JSON Schema | 运行时再次校验；DAG 不变量和蒸馏动作业务校验；官方 SDK、受管理 worker 和全局 AI 额度 |
| HTTP 校验 | 集中 RequestContracts，Express 5 统一接收校验异常 | 参数不隐式转换；审核实际版本约束；输入 400、不存在 404、状态冲突 409、内部故障 500 |
| SSE 与报告 | EventSource 原生重连；恢复后刷新查询；sanitize-html 净化服务端 Markdown | 多组件共享连接；最后一个订阅者退出才关闭；文件白名单与路径约束 |
| 前端查询 | TanStack Vue Query 管理任务、图、详情和附属资源的缓存、去重与取消 | Issue/版本作为查询键；详情版本不倒退；编辑草稿独立；迟到保存响应只更新原 Issue；写入不自动重试 |

新增直接运行时依赖：`@octokit/rest@22.0.1`、`@octokit/plugin-retry@8.1.1`、`@octokit/plugin-throttling@11.0.5`、`p-limit@7.3.3`、`sanitize-html@2.18.0`、`@tanstack/vue-query@5.104.1`。新增开发类型依赖 `@types/sanitize-html@2.16.2`；复用既有 Execa、Zod 和官方 Codex SDK。

## 必须保留的适配

删除了 `RetryPolicy`、`Semaphore`，以及普通进程的重复 taskkill/超时控制、手写组合信号、SSE 重连计时器和前端资源请求序号。保留 AI ConcurrencyLimiter、AsyncMutex、GitOperations、PortAllocator、LangGraph 与聚合事务存储。

`splitCommand` 继续保留。现有 Execa 命令字符串解析不能满足带引号的 Windows 中文空格路径约束，替换会改变实际预览与安装命令行为。

GitHub 错误转换仍提取等待时间，供上层判断限流和恢复；它不负责重试循环。分页预算仍是业务完整性要求，超过预算抛错，不返回截断结果。GitHub Search API、图布局库和额外 HTTP 框架不在本轮范围内。

## 真实 SDK 兼容性

真实调用发现判别联合生成的 `oneOf` 不被 Codex 结构化输出接受。蒸馏契约改用 Zod 普通联合生成 `anyOf`；生成时将对象字段标记为必填，可选值以 `null` 表示，运行时解析归一为原有的 `undefined`。既有省略字段仍可由运行时契约解析，无数据格式自动迁移。

约束依据：[OpenAI Docs 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。字段仍由同一份 Zod 定义生成，没有重新维护一套手写 JSON Schema。

四类真实输出通过 `scripts/structured-output-smoke.ts` 分别校验。该脚本在新建临时仓库使用受管理 worker、只读模式和固定样例，不作为真实开发流水线或项目 UAT 的成功证明。

手动复验命令：

```powershell
npm exec -- tsx scripts/structured-output-smoke.ts
```

`parseJsonOutput` 的短小代码块兼容保留在蒸馏输入边界，结构校验仍由 Zod 完成。

## 回归边界

工程检查包括类型检查、ESLint、前后端生产构建、保留测试集、Windows 专项和真实浏览器工作台端到端。模拟回归中的 Git 与浏览器是真实运行，AI 和 GitHub 为模拟；四类 Codex Schema 是独立真实模型调用。本轮未创建真实 GitHub Issue、PR 或发布产物。

Windows 专项覆盖中文空格目录、.cmd、超时取消、进程树终止和预览端口释放。Linux/macOS 未实机验证。

验收中同时修正了两处相关边界：知识展示按字段子集提取完整存储记录，允许合法的 id/版本元数据；普通内部异常不再统统归为用户输入错误。旧测试中的分页响应增加标准 Link 头，fetch 模拟使用标准 Response，审核 API 测试复用实际 createApp 错误处理。

实际改动量和最终检查结果见 [验收摘要](evidence/infrastructure-simplification.json)。源码统计包含注释、空行和新增文件，排除测试、脚本、文档与依赖锁文件；依赖安装后的总代码体积不作为源码精简指标。此次未进行性能基准测试。
