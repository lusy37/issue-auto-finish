# 底层依赖迁移记录

## 进程与程序查找

引入 Execa 10.0.1、which 6.0.1，移除直接依赖 cross-spawn 及其类型包。Node 最低版本调整为 22.12，同时满足 Execa 和现有 Vite 的要求；本机运行版本为 22.18.0。

`src/utils/process.ts` 保留统一入口。Execa 负责启动、超时、取消、进程树清理及完成等待；which 负责 PATH、PATHEXT 和可执行程序查找。预览服务以及改为 TypeScript 的 `scripts/dev-all.ts` 共用这个入口，删除各自手写的 taskkill、进程组及强制终止计时器。

业务约定：

- `runProcess` 继续接收程序、参数数组、工作目录、环境、取消信号和日志回调；普通命令默认超时 300 秒。
- 普通非零退出码返回给业务层判断；取消、超时及原生进程启动失败继续上抛。Windows 找不到命令时，Execa 可能通过 cmd 返回退出码 1 和错误输出，工作台仍判为命令失败。
- 日志实时输出，stdout/stderr 分别保留末尾 8,000,000/2,000,000 个字符，不因超过日志长度而中止构建。
- 后台进程显式启用 `killDescendants`。内部调用方使用 Execa 的进程句柄；原生事件和输出流通过 `nodeChildProcess` 访问。
- Codex 执行仍由官方 SDK 管理；不改写 SDK 的执行层。

2026-09-12 Windows 本机验证：类型检查、后端构建通过；进程、Git、预览及端口恢复相关 41 项测试通过（首次批次有 1 项测试假设与 Execa 的 Windows 行为不符，修正为验证原生启动失败后，进程 7 项复验通过）。新增检查覆盖预先取消、无效工作目录、非零退出码、实时中文输出、长日志、自定义 PATHEXT、取消及超时后的后代进程与端口清理。

进程复验及构建日志保存于 `.iaf-mini/dependency-migration/`。本次验收范围是 Windows；Linux/macOS 未验证。

依据：[Execa 进程终止](https://github.com/sindresorhus/execa/blob/v10.0.1/docs/termination.md)、[Execa 接口](https://github.com/sindresorhus/execa/blob/v10.0.1/docs/api.md)、[which](https://github.com/npm/node-which)。
