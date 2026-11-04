---
title: 替换与停止
description: 远程插件如何停止、如何被替换，以及如何应对断网。
---

远程插件的进程跟随它的条目：卸载条目会停止它，重启条目会替换它。通过 runner 运行时，Remote 保证：

- 只有确认旧进程已经退出，替换才会开始。
- 实例的每次启动都拿到更大的 generation，runner 重启后也是如此。

## 停止

远程条目停止时，Remote 按以下顺序进行：

1. **停止使用方。** 使用该插件服务的宿主插件先停止，此时这些服务仍然可用。
2. **优雅停止。** 插件在自己的进程中被卸载，finalizer 照常运行，受
   `shutdownTimeout` 限制。
3. **确保进程已经消失**，做法取决于插件在哪里运行：

| 运行在   | 优雅停止之后                                                                                  |
| -------- | --------------------------------------------------------------------------------------------- |
| `local`  | 还有一秒自行退出，之后被终止，再过一秒用 `SIGKILL` 杀掉。Remote 一直等到确认退出。            |
| `worker` | 还有一秒自行退出，之后调用 `worker.terminate()`。Remote 一直等到线程确实退出。                |
| Runner   | runner 中断进程，过了 `grace` 仍在运行就杀掉它。宿主最多等待租约加 `margin`，等 runner 确认。 |

`local` 子进程或 worker 错过这一秒的窗口时，会以 `LocalTerminationTimeout`
出现在 `Fork.CleanupError` 的 `cause`
中，即使随后的终止成功也一样。这通常说明 finalizer 运行完之后，还留着定时器、套接字或其他句柄。

## Generation 与 fencing

runner 给实例的每次启动分配一个
**generation**（代次）：一个存在磁盘上、只增不减的数字。插件从 `Instance`
读取自己的 generation：

```ts
Effect.gen(function* () {
	const { id, generation } = yield* Instance
	yield* ledger.claim({ owner: id, generation })
})
```

| 运行在           | `id`                | `generation`     |
| ---------------- | ------------------- | ---------------- |
| 通过 runner      | 实例名              | 每次替换都会增长 |
| `local`/`worker` | 每次启动一个新 UUID | 始终为 `1`       |
| 不是远程插件     | `local`             | `0`              |

用它来做
**fencing**：外部系统记住见过的最大 generation，拒绝来自更小 generation 的写入，慢吞吞的旧副本就无法覆盖新副本的工作。

- 外部系统必须自己检查 generation，Remote 不会替你检查。
- 它不会撤销已经发生的写入，也不能让调用恰好执行一次。
- 每个 runner 各自计数，不同的 runner 之间不做协调。
- runner 重启后，状态目录记得哪些进程当时仍在运行，runner 会先处理它们，再进行替换。

## 租约与断网

宿主对插件进程持有一份**租约**，每过租约的三分之一续期一次。宿主停止续期（崩溃或网络中断）时，runner 会在租约到期时停止插件进程。runner 自己消失时，它的插件进程也会关闭。

连接断开时：

- 正在进行的调用失败，错误是 `fromClient` 把 `RpcClientError`
  映射成的那个。调用不会重试，正在调用插件的 finalizer 也可能被中断。
- 宿主条目以 `RemoteError`
  失败，其中包含连接错误。它在配置或依赖变化时再次启动；通过 `Remote.plugin`
  加载时，还会按 `retry` 计划重试。
- 插件进程会一直运行到租约到期。
- 下一条连接在确认它退出后替换它，generation 随之增长。

租约不是硬实时的：整台机器挂起时，执行也随之暂停。runner 在向进程发信号前会核对进程身份，但仍有一个很窄的窗口，被复用的进程 ID 可能被误认为原进程。请让[服务管理器](../runners/#部署-runner)负责 runner 的后代进程。

## 结果

| 结果                           | 含义                                                  | 体现在                                      |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------- |
| `Exited`                       | 插件已停止，退出已确认。                              | 宿主日志中的 `remote.termination`。         |
| `Killed`                       | 进程被杀掉，且已确认。部分 finalizer 可能没有执行完。 | 宿主日志中的 `remote.termination`。         |
| `RemoteTerminationUnconfirmed` | 没人能确认退出：宿主失去联系，或 runner 无法确认。    | dispose 时 `Fork.CleanupError` 的 `cause`。 |

这条日志是 info 级别的 `Remote execution terminated`，带有
`remote.termination`、`remote.instance` 和 `remote.generation` 注解。请把
`RemoteTerminationUnconfirmed`
当作“可能仍在运行”：等到超时什么也证明不了，请检查 runner 所在机器。在确认退出之前，runner 拒绝为该实例启动替换。如果插件经常以
`Killed` 结束，请调大 `shutdownTimeout`，或找出让它们忙个不停的原因。

## 超时与默认值

| 项目                          | 默认值             | 设置方式                                          |
| ----------------------------- | ------------------ | ------------------------------------------------- |
| 优雅停止                      | 5 秒               | `Remote.plugin` 的 `shutdownTimeout`；YAML 中固定 |
| `local`/`worker` 的退出窗口   | 1 秒               | 固定                                              |
| `local`：终止后发送 `SIGKILL` | 再过 1 秒          | 固定                                              |
| 租约                          | 15 秒              | runner 的 `lease`，或宿主的 `connect.lease`       |
| 租约续期                      | 每过租约的三分之一 | 固定                                              |
| runner 上从中断到杀掉         | 5 秒               | runner 的 `grace`                                 |
| 宿主等待退出确认              | 租约 + 5 秒        | 宿主的 `connect.margin`                           |

时长写成 `30 seconds` 或 `500 millis` 这样的字符串。`lease`、`grace` 和 `margin`
必须是有限的正值。
