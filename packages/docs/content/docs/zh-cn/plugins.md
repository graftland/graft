---
title: 插件
description: 使用 Plugin.make、Plugin.service 和 Plugin.layer 定义插件。
---

插件是一个描述如何启动某项功能的值。加载插件会创建一个
**fork**，即拥有独立配置和 `Scope`
的运行实例。同一个插件加载两次，会得到两个独立的 fork。

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
			Effect.forkScoped,
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
| `retry`  | 在 `apply` 失败后重启插件的 `Schedule`。                               |

`apply` 在一个 `Scope` 内运行，只要插件仍处于加载状态，这个 `Scope`
就保持打开。插件拥有的一切都应交给它管理：用 `Effect.acquireRelease`
管理资源、用 `Effect.forkScoped` 启动后台 fiber、用 `Graft.plugin`
加载子插件、用 `Event.on` 注册事件处理函数。插件卸载或重启时，Graft 会关闭这个
`Scope`，按相反顺序释放这些资源。

`apply` 执行结束表示插件已启动。需要持续执行的工作应交给归属于该 `Scope`
的 fiber，就像 `ticker` 一样。`apply`
不返回值，或返回一个[更新函数](#原地更新)，因此 `ticker` 用 `Effect.asVoid`
丢弃返回的 fiber 值。

### 配置解码

配置 schema 支持 Schema 的全部解码能力，包括异步解码和依赖服务的解码。解码需要的服务和其他依赖一样，必须列入
`inject`，编译器会检查这一点。解码失败时，fork 会以 `SchemaError` 失败。

## 依赖

`inject`
列出插件需要的服务。只有这些服务全部可用时，插件才会启动；任何一个服务释放之前，插件都会先停止。

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
可以返回一个更新函数。该函数接收每次传入的新配置，成功应用变更后返回
`true`，需要重启则返回 `false`。

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

## 失败与重试

如果 `apply` 失败，fork 会进入 `Failed` 状态并保留完整的
`Cause`，插件获取的所有资源都会释放，失败也会记录到日志中。随后，fork 会等待下一次尝试：配置变化、依赖变化或
`retry` 调度触发时，都会重试。

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
中列出的服务。每个 fork 都会独立构建这个 Layer，并在停止时销毁它：

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
获取的资源，而且[热重载](../hot-reload/)会在每次变更时重新导入模块。
