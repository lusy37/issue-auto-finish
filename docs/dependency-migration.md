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

## 原子 JSON 写入

引入 atomically 2.1.1，以 writeJsonAtomicSync 统一 BaseTracker、DraftService、VersionStore、DistillScheduler 和演示平台的写入。数据格式保持原样，继续同步保存；移除调用方的临时文件创建、写入后重命名，以及手写的占用重试循环。

重试窗口显式设为 350 毫秒（库按单次文件操作计时），保留库默认 fsync。循环引用及 undefined 在创建临时文件之前失败。atomically 的失败清理可能异步完成，因此统一入口保留一段同步清理适配：失败时尝试删除本次临时文件，再上抛原始错误；清理失败不覆盖原始诊断。

该迁移提交中的 BaseTracker 保留启动清理，同时识别当时的新旧临时文件命名。后续 e4fb2f2 已删除旧命名分支，当前仅清理 atomically 生成的残留临时文件，见 [遗留兼容盘点](compatibility-audit.md)。业务错误仍附带 code、errno、syscall、path 和 cause。本次迁移只统一上述已有原子写入路径，不把文件写入当作跨文件事务，也不改变业务锁。

2026-09-12 Windows 验证：类型检查、前后端构建通过；存储相关 66 项通过，完整回归 97 个文件、937 项通过。故障测试在独立 Node 进程中注入真实库调用的文件系统错误，覆盖 EPERM/EACCES/EBUSY 重试、持续占用的有限重试、EIO、部分写入后的 EDQUOT、旧数据保留和临时文件清理。Tracker 另验证错误包装与重启读取上次成功状态。

源码统计以迁移前 c5a83ba 为基线：进程工具、预览及开发脚本净减少 106 行，原子写入工具与相关调用净减少 32 行，合计净减少 138 行。统计采用 Git 的新增/删除行差额，包含源码注释和空行，不包括依赖锁文件、测试与文档。

依据：[atomically 接口与选项](https://github.com/fabiospampinato/atomically#usage)。

## 最终验收与提交

进程迁移提交：8d06997；存储迁移提交：d2852b1。类型检查、前后端构建、完整回归 937 项、Chrome 工作台端到端 1 项及 Windows 专项 1 项均通过。Windows 专项也是完整回归的组成部分，不能重复累加为独立覆盖数量。

本次没有重新调用真实 Codex 或创建真实 GitHub 交付；模拟平台/AI 配合真实 Git 和浏览器的主流程已在完整回归中通过。原真实验收继续保留在原记录中，不能视为本次重新执行。

机器可读摘要见 [验收证据](evidence/dependency-migration.json)。源码提交时间使用本次实际开发时间，未新增阶段标签。
