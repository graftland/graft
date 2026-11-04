---
title: 重启、替换与停止
description: 重新部署、断网和插件停不下来时远程插件会怎样，以及如何隔离外部副作用。
---

本页面向远程插件的运维。这里说明重新部署、宿主或网络消失、插件没能及时停止时会发生什么，以及这些情况在日志和错误中如何体现。

## 远程插件如何停止

远程条目被卸载、重启或替换时，Remote 分两个阶段停止它的插件进程：

1. **优雅停止。** 插件在自己的进程里被卸载，finalizer 照常运行。这一阶段受
   `shutdownTimeout` 限制，默认五秒。只有 `Remote.plugin`
   能修改它；YAML 条目始终是五秒。
2. **确保进程已经消失。** 接下来怎么做取决于插件在哪里运行：

| 运行在      | 优雅停止之后                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `local`     | 进程还有一秒自行退出。之后被终止，再过一秒用 `SIGKILL` 杀掉。Remote 会一直等到确认退出。                                             |
| `worker`    | worker 还有一秒自行退出。之后调用 `worker.terminate()`，Remote 会一直等到线程确实退出。                                              |
| 通过 runner | runner 中断插件进程；过了 `grace`（默认五秒，在 `runner.yml` 中设置）仍在运行就杀掉它。宿主最多等待租约加 `margin`，等 runner 确认。 |

对 `local` 和 `worker`
来说，超出这一秒的窗口会记为清理错误（`LocalTerminationTimeout`），即使随后的终止成功也一样。这通常说明插件在 finalizer 运行完之后，还留着定时器、套接字或其他句柄。

## 重新部署插件

以下情况会替换插件进程：

- 宿主重载或重启条目，例如它的 `config` 或 `connect` 改变了；
- 宿主进程本身重启；
- runner 收到同一身份、同一实例的新连接。

对于直连的 `local` 或 `worker` 插件，每次启动都只是一个全新的进程。

通过 runner 时，替换要严格得多。runner
**确认旧进程已经退出之后，才会启动新进程**。如果无法确认，替换就会失败，而不是让两个副本同时运行。runner 重启后同样如此：状态目录记得哪些进程当时仍在运行，runner 再次启动时会先处理它们。

向 runner 部署插件包的新版本：

1. 把新包安装到 runner 的安装目录。
2. 在宿主上重启这个远程条目，或者重启宿主。

runner 上的实现模块不参与宿主的[热重载](../../hot-reload/)，在那边保存文件对宿主没有任何作用。如果**契约**变了，请重新构建并重启宿主：契约的导入同样不参与热重载。

## Generation：隔离外部副作用

runner 每为某个实例启动一次插件，就给这次启动分配一个
**generation**（代次）：一个只增不减的数字。runner 把它存在磁盘上，所以 runner 重启后它仍会继续增长。

当插件要写入自身之外的东西（数据库、队列、锁）时，就需要 generation。替换期间，一个慢吞吞的旧副本可能在新副本启动时仍在完成某次写入。如果外部系统记住见过的最大 generation，并拒绝来自更小 generation 的写入，旧副本就无法覆盖新副本的工作。这种做法叫作
**fencing**。

插件从 `Instance` 读取自己的身份：

```ts
import { Plugin } from "@graftland/graft"
import { Instance } from "@graftland/plugin-remote"
import { Effect } from "effect"

export default Plugin.make({
	name: "ledger",
	inject: [Ledger],
	apply: () =>
		Effect.gen(function* () {
			const { id, generation } = yield* Instance
			const ledger = yield* Ledger
			yield* ledger.claim({ owner: id, generation })
		}),
})
```

| 运行在           | `id`                | `generation`     |
| ---------------- | ------------------- | ---------------- |
| 通过 runner      | 实例名              | 每次替换都会增长 |
| `local`/`worker` | 每次启动一个新 UUID | 始终为 `1`       |
| 不是远程插件     | `local`             | `0`              |

generation 是一种工具，本身并不构成保证：

- 外部系统必须自己检查它，Remote 不会替你检查。
- 它不会撤销已经发生的写入。
- 它不能让调用恰好执行一次。
- 它不协调不同的 runner，每个 runner 各自计数。

## 租约

runner 分不清一个安静的宿主和一个已经死掉的宿主，所以宿主持有一份**租约**：一个定期续期、表示“我还在”的承诺。租约默认 15 秒。runner 用
`lease` 设置默认值，宿主条目可以用 `connect.lease` 申请不同的时长。

- 宿主停止续期（崩溃或网络中断）时，runner 会在租约到期时停止插件进程。
- runner 自己消失时，它的插件进程也会察觉并自行关闭。

租约有一些需要知道的局限：

- 它不是硬实时的期限。整台机器挂起时，执行也随之暂停。
- runner 在向进程发信号前会核对进程身份，但仍有一个很窄的窗口，被复用的进程 ID 可能被误认为旧进程。
- 请让服务管理器负责 runner 的后代进程，见[在另一台机器上运行插件](../runners/#4-启动-runner)。

## 网络断开时

宿主与 runner 之间的连接断开时：

- 正在进行的调用会失败。调用方看到的是服务的 `fromClient` 将 `RpcClientError`
  映射成的错误。调用不会重试，正在调用插件的 finalizer 也可能被中断。
- 宿主上的远程条目以 `RemoteError`
  失败，其 cause 中包含连接错误。它会像其他失败的插件一样再次启动：在配置或依赖变化时；如果通过
  `Remote.plugin` 加载，还会按它的 `retry` 计划重试。
- 在 runner 上，插件进程会一直运行到租约到期。连接本身并不决定它活多久。
- 宿主重新连接时，新连接会在确认旧进程退出后替换它，generation 随之增长。

runner 会记录一条警告
`Remote host connection failed`，附带原因和宿主身份。宿主正常断开时不会有警告。

## 插件停不下来时

对于直连插件，停止缓慢表现为
`LocalTerminationTimeout`（见[远程插件如何停止](#远程插件如何停止)）。通过 runner 时，每次停止都会落入以下三种结果之一：

| 结果                           | 含义                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `Exited`                       | 插件正常停止，进程退出已确认。                                   |
| `Killed`                       | 进程不得不被杀掉，且已确认被杀。有些 finalizer 可能没有执行完。  |
| `RemoteTerminationUnconfirmed` | 没有人能确认进程已经退出：宿主失去了联系，或者 runner 无法确认。 |

前两种会出现在宿主的 `Remote execution terminated` 日志中，带有
`remote.termination`、`remote.instance` 和 `remote.generation` 注解。

`RemoteTerminationUnconfirmed` 是清理错误：`dispose` 以 `Fork.CleanupError`
失败，可以在它的 `cause`
中找到它。请把它理解为“进程可能仍在运行”。等到超时并不能证明进程已经退出。请检查 runner 所在的机器。在 runner 能确认退出之前，它会拒绝为这个实例启动替换进程。

如果插件经常以 `Killed` 结束，可以用 `shutdownTimeout`
给 finalizer 更多时间，或者找出是什么让它们一直忙着。

## 停止期间的服务

Remote 在边界两侧保持 Graft 一贯的[撤回顺序](../../services/#服务撤回流程)：

- 使用远程插件服务的插件，会在这些服务被撤回**之前**停止，所以它们的 finalizer 仍能调用健康的远程服务。
- 如果契约 `inject` 中的某个宿主服务被撤回，远程插件会停止，直到服务恢复。
- 如果远程插件撤回它提供的服务，使用该服务的宿主插件会停止。撤回之后发出的调用以
  `RemoteWithdrawn` 失败。
- 连接断开仍可能在任何时刻中断调用和 finalizer。

## 日志

插件进程的日志会转发到宿主的 logger。负载很高时可能丢失一部分，宿主会记录
`Remote logs were dropped` 以及丢失的条数。
