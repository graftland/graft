---
title: 插件
description: 使用 Plugin.make、Plugin.service 和 Plugin.layer 定义插件。
---

插件是一个描述如何启动某项功能的值。加载插件会创建一个
**fork**：一个运行实例，拥有独立的配置和自己的
`Scope`。同一个插件加载两次，会得到两个独立的 fork。

| 术语       | 含义                                       |
| ---------- | ------------------------------------------ |
| **Plugin** | 定义本身。它只是一个值，加载之前不会运行。 |
| **Fork**   | 插件的一个运行实例。                       |
| **Scope**  | 持有 fork 的资源。关闭它即释放这些资源。   |

## 定义插件

```ts
import { Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

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

### 选项

| 选项     | 作用                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `name`   | 用于日志和 fork 树的名称。                                             |
| `config` | Effect `Schema`，用于在运行 `apply` 前解码输入。不需要配置时可以省略。 |
| `inject` | 插件需要的服务。参见[依赖](#依赖)。                                    |
| `apply`  | 启动插件，在 fork 的 `Scope` 内运行。                                  |
| `retry`  | 在 `apply` 或受监督任务失败后重启插件的 `Schedule`。                   |

### 在 `apply` 内使用什么

`apply` 在插件加载期间保持打开的 `Scope` 中运行。每一类工作都交给对应的工具：

| 你需要         | 使用                    |
| -------------- | ----------------------- |
| 需要清理的资源 | `Effect.acquireRelease` |
| 后台工作       | `Plugin.fork`           |
| 子插件         | `Graft.plugin`          |
| 事件处理函数   | `Event.on`              |

### 后台任务

`Plugin.fork(effect)` 启动一个受监督的任务并返回它的 fiber。

- **归属。** activation 把 fiber 保存在 `FiberSet` 中，即使调用方用
  `Effect.asVoid` 丢弃句柄，也不会失去监督。
- **启动。** `apply` 结束表示启动完成，任务可以继续运行。
- **Context。** 任务继承启动处的 context，因此可以使用 `inject` 中声明的依赖。
- **资源。** 每个任务都有自己的
  `Scope`。任务获取的资源会在任务结束或被取消时释放，即使任务是从存活时间更短的 scope 中启动的。

### 任务失败时

任务未处理的错误或 defect 会使整个 activation 失败，即使 `apply`
仍在加载，或正在原地更新，也是如此。Graft 按以下顺序清理：

1. 停止 `apply`，关闭发布并撤回服务。
2. 排空消费者。期间仍健康的任务继续服务这些消费者。
3. 停止剩余任务，等待它们清理完成。
4. 关闭 activation 的资源。

失败的细节：

- **保留 Cause。** Graft 会记录任务失败及取消 defect 的完整 Cause。
- **中断不是失败。** 任务仅被中断不会使插件失败。
- **重试从干净状态开始。** 插件的 `retry`
  调度仍然适用，每次尝试都会创建新的任务组。
- **快速清理。**
  如果更新或卸载先于 Graft 处理该失败而发生，Graft 清理旧 activation 时仍会记录这次失败。

### 类型中的任务错误

任务的错误会纳入插件的错误类型和
`fork.await`，包括在更新回调、服务、layer 或其他任务中启动的任务。`Plugin.Tasks<E>`
会将这个约束一直传到插件定义处，因此带类型标注的辅助函数必须保留它。

:::caution

要恢复某个错误，请在任务**内部**捕获它，也就是在把任务传给 `Plugin.fork`
之前。下面两种做法都不会撤销监督：

- 捕获启动操作的错误。
- join 返回的 fiber 后捕获其错误。

:::

裸 `Effect.forkScoped`
只管理 fiber 的生命周期，不会把 fiber 的失败交给 Graft。插件任务应使用
`Plugin.fork`。如果有意使用裸 fiber，需要自行观察其完整的 `Exit` 或 `Cause`。

### 配置解码

配置 schema 可以做 schema 能做的任何事，包括异步解码和需要服务的解码。

- 解码需要的服务和其他依赖一样，必须列入 `inject`，编译器会检查这一点。
- 解码失败时，fork 会以 `SchemaError` 失败。

## 依赖

`inject`
列出插件需要的服务。只有这些服务全部存在时，插件才会启动；任何一个服务消失之前，插件都会先停止。

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

| 类型     | 声明方式                 | 读取方式               | 服务缺失时                         |
| -------- | ------------------------ | ---------------------- | ---------------------------------- |
| **必需** | `Database`               | `yield* Database`      | fork 在 `Pending` 状态等待。       |
| **可选** | `Plugin.optional(Cache)` | `Effect.serviceOption` | 插件照常启动，并在服务变化时重启。 |

- 读取未在 `inject` 中声明的服务会触发类型错误，因此不会漏掉依赖声明。
- 可选依赖会在服务出现或消失时重启插件，确保插件始终读取到当前状态。

缺少必需服务时，fork 处于 `Pending` 状态。参见[生命周期](../lifecycle/)。

## 原地更新

默认情况下，新配置会使插件重启：Graft 关闭旧的 Scope，再运行一次
`apply`。如果希望插件继续运行，`apply` 可以返回一个更新函数。

| 更新函数……                 | 含义           |
| -------------------------- | -------------- |
| 接收 supervisor 选中的配置 | —              |
| 返回 `true`                | 变更已应用。   |
| 返回 `false`               | 改为重启插件。 |

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

通过 [Remote](../remote/overview/)
运行的插件不会原地更新：新配置会重启它的插件进程。

:::note

更新只保留最新请求的配置，不会排队逐项交付。并发请求可能完全跳过中间配置。被后续请求取代的
`fork.update` 也会成功返回，即使它的输入从未传给回调。

:::

解码和执行更新组成一个可取消的操作：

- 后续配置或依赖变化会取消它，并等待其清理完成后再进行清理。
- 普通更新失败会先记录完整 Cause，再重启；卸载期间收集到的失败也会进入
  `CleanupError.cause`。
- 更新中取得的资源仍属于 activation Scope。

## 失败与重试

如果 `apply` 或受监督任务失败，fork 会进入 `Failed` 状态并保留完整的
`Cause`。Graft 会释放插件获取的所有资源，并把失败记录到日志中。随后 fork 进入等待，在以下任一情况发生时重试：

- 它的配置发生变化。
- 它的某个依赖发生变化。
- 它的 `retry` 调度触发。

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## 从服务和 Layer 创建插件

对于只发布服务的插件，可以使用两种简写方式。

| 简写             | 构建对象            | 发布内容                  |
| ---------------- | ------------------- | ------------------------- |
| `Plugin.service` | 一个服务            | 该服务。                  |
| `Plugin.layer`   | 一个 Effect `Layer` | `provides` 中列出的服务。 |

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` 为每个 fork 独立构建这个 Layer，并在 fork 停止时销毁它：

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## 插件模块

加载器和 CLI 从模块中导入插件。

- **导出。** 模块通过默认导出或名为 `plugin` 的导出提供插件，`Plugin.fromModule`
  也按相同的方式读取。
- **无副作用。** 导入插件模块时，除了定义插件，不应执行其他操作。Graft 只能释放
  `apply` 获取的资源。
- **重载。** 自动[热重载](../hot-reload/)会重新导入受变化影响的模块；公开的
  `hmr.reload` 则强制全量重载。
