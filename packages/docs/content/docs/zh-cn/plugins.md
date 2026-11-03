---
title: 插件
description: 使用 Plugin.make、Plugin.service 和 Plugin.layer 定义插件。
---

插件是一个描述如何启动某项功能的值。加载插件会创建一个
**fork**。fork 是一个运行实例，拥有独立的配置和
`Scope`。同一个插件加载两次，会得到两个独立的 fork。

## 定义插件

```ts
import { Plugin } from "@graftland/graft"
import { Effect, Schedule, Schema } from "effect"

export const ticker = Plugin.make({
	name: "ticker",
	config: Schema.Struct({ every: Schema.Duration }),
	apply: ({ every }) =>
		Effect.log("tick").pipe(
			Effect.repeat({ schedule: Schedule.spaced(every) }),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

| 选项     | 作用                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `name`   | 用于日志和 fork 树的名称。                                             |
| `config` | Effect `Schema`，用于在运行 `apply` 前解码输入。不需要配置时可以省略。 |
| `inject` | 插件需要的服务。参见[依赖](#依赖)。                                    |
| `apply`  | 启动插件，在 fork 的 `Scope` 内运行。                                  |
| `retry`  | 在 `apply` 或受监督任务失败后重启插件的 `Schedule`。                   |

`apply` 在插件加载期间保持打开的 `Scope` 中运行。用 `Effect.acquireRelease`
管理资源、用 `Plugin.fork` 启动后台任务、用 `Graft.plugin` 加载子插件、用
`Event.on` 注册事件处理函数。

`Plugin.fork(effect)` 返回任务的 fiber。activation 的 `FiberSet`
持有这个 fiber，即使调用方用 `Effect.asVoid` 丢弃句柄，也不会失去监督。`apply`
结束表示启动完成，任务可以继续运行。任务继承启动处的 context，因此可以使用
`inject` 声明的依赖。每个任务都有自己的
`Scope`。任务获取的资源会在任务结束或被取消时释放，即使任务是从存活时间更短的 scope 中启动的。

任务未处理的错误或 defect 会使整个 activation 失败。即使 `apply`
尚未结束，或正在原地更新，也是如此。Graft 先停止
`apply`，关闭发布并撤回服务，再排空消费者，期间仍健康的任务继续服务这些消费者。排空之后，Graft 才停止剩余任务、等待其清理完成，并关闭 activation 的资源。Graft 会保留任务失败及取消 defect 的完整 Cause，并记录日志。任务仅被中断不会使插件失败。插件通常的
`retry`
调度仍然适用，每次重试都会创建新的任务组。有时更新或卸载会先于失败被处理，此时 Graft 清理旧 activation 时仍会记录该失败。

任务的错误会纳入插件的错误类型和
`fork.await`，包括在更新回调、service、layer 或其他任务中启动的任务。`Plugin.Tasks<E>`
将这个约束传到插件定义处。带类型标注的辅助函数必须保留它。可恢复的错误应在任务**内部**处理，也就是在把任务传给
`Plugin.fork`
之前。捕获启动操作的错误，不会撤销监督；join 返回的 fiber 后捕获其错误，同样不会撤销监督。

裸 `Effect.forkScoped`
管理 fiber 的生命周期，但不会把 fiber 的失败交给 Graft。插件任务应使用
`Plugin.fork`。如果有意使用裸 fiber，需要自行观察其完整的 `Exit` 或 `Cause`。

### 配置解码

配置 schema 可以做 schema 能做的任何事，包括异步解码和需要服务的解码。解码需要的服务和其他依赖一样，必须列入
`inject`，编译器会检查这一点。解码失败时，fork 会以 `SchemaError` 失败。

## 依赖

`inject`
列出插件需要的服务。只有这些服务全部可用时，插件才会启动。任何一个服务释放之前，插件都会先停止。

```ts
const report = Plugin.make({
	name: "report",
	inject: [Database, Plugin.optional(Cache)],
	apply: () =>
		Effect.gen(function* () {
			const database = yield* Database
			const cache = yield* Effect.serviceOption(Cache)
			// ...
		}),
})
```

- **必需依赖**（如 `Database`）可以通过 `yield*` 读取。读取未在 `inject`
  中声明的服务会触发类型错误，因此不会漏掉依赖声明。
- **可选依赖** `Plugin.optional(Cache)` 不会阻止插件启动，使用
  `Effect.serviceOption`
  读取。服务出现或消失时，插件都会重启，确保读取到当前状态。

缺少必需服务时，fork 处于 `Pending` 状态。参见[生命周期](../lifecycle/)。

## 原地更新

默认情况下，新配置会使插件重启：Graft 关闭旧的 `Scope`，再运行一次
`apply`。如果希望插件继续运行，`apply`
可以返回一个更新函数。该函数接收 supervisor 选中的配置。如果已应用变更，返回
`true`；如果需要重启，返回 `false`。

更新只保留最新请求的配置，不会排队逐项交付。并发请求可能完全跳过中间配置。被后续请求取代的
`fork.update` 也会成功返回，即使它的输入从未传给更新回调、最新配置也尚未应用。

```ts
const server = Plugin.make({
	name: "server",
	config: Schema.Struct({ port: Schema.Int, banner: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			const banner = yield* Ref.make(config.banner)
			yield* startServer(config.port, banner)
			return (next) =>
				next.port === config.port
					? Effect.as(Ref.set(banner, next.banner), true)
					: Effect.succeed(false)
		}),
})
```

更新函数是一个闭包，可以使用 `apply` 创建的任何值，例如这里的 `banner`。

解码和执行更新组成一个可取消的操作。后续配置或依赖变化会取消它，并等待其清理完成后再进行 activation 清理。普通更新失败会先记录完整 Cause，再重启；卸载期间收集到的失败也会进入
`CleanupError.cause`。更新中取得的资源仍属于 activation Scope。

## 失败与重试

如果 `apply` 或受监督任务失败，fork 会进入 `Failed` 状态并保留完整的
`Cause`。Graft 会释放插件获取的所有资源，并把失败记录到日志中。随后，fork 会等待下一次尝试：配置变化、依赖变化或
`retry` 调度触发时，都会重试：

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## 从服务和 Layer 创建插件

对于只发布服务的插件，可以使用以下两种简写方式。

`Plugin.service` 创建并发布一个服务：

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` 构建一个 Effect `Layer`，并发布 `provides`
中列出的服务。Graft 为每个 fork 独立构建这个 Layer，并在 fork 停止时销毁它：

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## 插件模块

加载器和 CLI 从模块中导入插件。模块通过默认导出或名为 `plugin`
的导出提供插件，`Plugin.fromModule` 也按相同的方式读取。

导入插件模块时，除了定义插件，不应执行其他操作。Graft 只能释放 `apply`
获取的资源。另外，[热重载](../hot-reload/)会在每次变更时重新导入模块。
