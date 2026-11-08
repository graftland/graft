# @graftland/graft

[English](https://github.com/graftland/graft/blob/main/packages/core/README.md)
| 简体中文 |
[繁體中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-TW.md)

基于 Effect 的插件框架：插件、fork、服务、隔离、事件和日志。

支持的 Node.js 最低版本是 22.19。

```sh
npm install @graftland/graft effect
```

用 `Plugin` 定义插件，用 `Graft` 运行插件，用服务和 `Event` 把它们连接起来。

用 `Plugin.fork(effect)` 运行由插件持有的后台任务。

- 如果 worker 失败或出现 defect 且无人处理，activation 就会失败。失败会携带完整的 Cause。之后 activation 按其重试计划重试。
- worker 主体的纯中断不会使 activation 失败。
- 插件被撤回后，健康的 worker 继续为已有消费者服务。只有这些消费者释放 lease 之后，worker 才会停止。这发生在 activation 资源关闭之前。
- worker 的错误类型通过 `Plugin.Tasks<E>` 成为插件契约的一部分。
- 请在 fork 之前，在 worker 内部处理可恢复的错误。
- 单独使用 `Effect.forkScoped` 只管理生命周期，不会把失败传给 Graft。

`fork.dispose` 的类型是 `Effect<void, Fork.CleanupError>`。

- 并发调用和重复调用共享同一个清理结果。
- `CleanupError.cause`
  保留所有原始失败原因。框架管理的 Scope 在释放时发生纯中断，会以
  `ReleaseInterrupted` defect 报告，原始中断保存在它的 `cause`
  中。这样，释放失败经过嵌套事件或后台任务仍能传到调用方；正常取消仍按中断处理。
- 即使某个 finalizer 失败，清理仍会继续完成资源释放和依赖 lease 的释放。
- activation 失败时，`Failed.cause` 也包含清理失败。
- 父 Scope 自动关闭时，Graft 把清理错误作为 defect 报告。该 defect 保留原始 Cause。

以下规则适用于 `inject` 中声明的依赖：

- 消费者所在领域（realm）中的 provision，优先于构建 `Graft.layer` 时的环境。
- 必选和可选消费者在该 provision 出现或被撤回时都会重启。环境中有值时，它们回落到环境值。
- provision 从不从父插件继承。每个子插件各自解析自己的依赖。
- 环境服务（ambient services）在各个领域中始终可用。
- 注入的 `Context.Reference`
  键同样会回落到继承的值和 intercept，或回落到默认值。它们不会因为没有值而停留在
  `Pending`。provision 仍然优先。

领域标签和服务键是身份中相互独立的两个部分。即使其中一个包含 NUL 字符，也是如此。共享标签永远不会指向私有领域或默认的根领域。

一次发布可能经由依赖变化或后代 scope 重启它自己的发布者。Graft 会以
`ServiceConflict` 原子地拒绝这样的发布。

- 必选的 `Pending` 依赖正在等待启动，不算作重启的 watcher。
- 被拒绝的发布者会一直等待，直到它的配置、依赖或造成阻塞的依赖图发生变化。

参见[服务文档](https://graftland.github.io/graft/zh-cn/services/)。

插件的身份就是对象引用的身份。

- 重复使用同一个定义，指的是同一个插件。
- `{ ...plugin }` 会创建一个不同的插件，即使字段完全相同。
- 加载和冲突检查都使用这条规则，与定义自身的 `Equal` 或 `Hash` 行为无关。

## 资源释放

需要让 finalizer 自身的中断在外层取消后仍可见时，使用
`Release.scoped`。已有 Scope 可用 `Release.close`
关闭。仅当释放 cause 全部由中断组成时，释放过程自己产生的中断才会成为携带原始 cause 的
`ReleaseInterrupted`
defect；预期的外部取消仍是 Interrupt。含有其他失败的 cause 原样保留。

## 文档

- [插件](https://graftland.github.io/graft/zh-cn/plugins/)
- [服务](https://graftland.github.io/graft/zh-cn/services/)
- [生命周期](https://graftland.github.io/graft/zh-cn/lifecycle/)

属于 [Graft](https://github.com/graftland/graft)。基于
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 许可。
