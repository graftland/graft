---
title: Fork 句柄
description: fork 的成员，以及 update、restart 和 dispose 的行为。
---

`Graft.plugin`
返回一个 fork 句柄。本页是它各成员的参考。关于状态，参见[生命周期](../lifecycle/)。

`generations`
以流的形式观察受管理 fork 的执行单元代；未受管理的 fork 返回空列表。`update` 和
`restart` 在更改受管理 fork 或其祖先之前以 `ManagedFork`
失败。见[执行转换](../transitions/)。

## 成员

| 成员            | 作用                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`            | 用于在树和日志中标识 fork 的数字。                                                                          |
| `state`         | 先发出当前状态，再发出每次变化的流，以 `Disposed` 结束。                                                    |
| `await`         | 等待 fork 离开 `Loading` 状态。如果最终进入 `Failed`，则以插件的错误失败。                                  |
| `stable`        | 等待当前 fork 及其后代都不再处于 `Loading` 状态。`Pending` 和 `Failed` 都视为已稳定；不会因子项失败而失败。 |
| `update(input)` | 向 fork 传入新输入。插件会[原地更新](../plugins/#原地更新)或重启。                                          |
| `restart`       | 使用相同的输入重启插件。                                                                                    |
| `dispose`       | 卸载插件及其加载的所有内容。                                                                                |

## `update` 和 `restart`

- 在请求被处理、被更新的请求取代，或 fork 已卸载时返回。
- fork 只保留最新请求的配置。并发更新可能跳过中间输入；被取代的更新也会成功返回。
- 成功返回不代表这一次配置已经交付，这些调用也不会等待重启完成。
- 要观察 fork 的当前状态，请使用 `await` 或
  `state`，不要用它们来确认已被取代的输入。

## `dispose`

- 并发及重复调用 `dispose` 共享同一次关闭操作及其完整结果，类型是
  `Effect<void, Fork.CleanupError>`。
- `CleanupError.cause` 保存原始的 typed failure、defect 和混合中断原因，它们来自
  `apply`、被中断的更新、受监督的任务、资源及 supervisor 清理。仅有纯中断时按正常停止处理。
- 每个清理阶段仍会执行，包括释放依赖 lease。
- `Failed.cause` 会把清理失败与原来的 activation 失败合并。结果一旦发布为
  `Failed`，之后卸载这个处于空闲状态的 fork 不会重放它；恢复时使用新的清理结果。
- 父 Scope 等待同一次清理，因此先卸载子级不会让父级资源提前释放。取消等待者不会取消清理。
- 公开的 dispose 在 fork 与父级解除挂接后完成。
- Scope 自动关闭时，`CleanupError`
  以 defect 形式抛出，因为 Effect 终结器没有 typed
  error 通道。错误中仍保留原始的 `Cause`。
- 请求卸载自己所在 fork 的处理函数，会被这次卸载中断。

## `await`、`stable` 和 `state`

| 你想等到……                     | 使用                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| fork 不再处于 `Loading`        | `await`。它把 `Pending` 视为已稳定，因为等待中的 fork 可能永远等不到服务。 |
| fork 正在运行                  | 观察 `state`，等待 `Active`。                                              |
| 整个子树没有 `Loading` 的 fork | `stable`。                                                                 |
| 加载器的编辑已完全协调完毕     | [`loader.ready`](../loader-api/)。                                         |

`fork.stable` 的类型是
`Effect<void>`。它读取子树计数器，无需构造或订阅整棵 fork 树，只描述当前状态，不涉及排队中的配置请求。配置协调器仍须检查请求版本和待处理的刷新。失败请通过
`state` 或 `await` 观察。

卸载后才订阅 `state`，仍会收到 `Disposed`，随后流结束。
