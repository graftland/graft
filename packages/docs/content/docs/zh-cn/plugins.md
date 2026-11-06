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

```ts import.meta.vitest name="plugins: define a plugin"
import { Duration, Effect, Option, Schedule, Schema, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const ticker = Plugin.make({
	name: "app/ticker",
	config: Schema.Struct({ every: Schema.Duration }),
	apply: ({ every }) =>
		Effect.log("tick").pipe(
			Effect.repeat({ schedule: Schedule.spaced(every) }),
			Plugin.fork,
			Effect.asVoid,
		),
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(ticker, { every: Duration.seconds(1) })
		yield* fork.await
		yield* Stream.runHead(fork.state) // => Option.some(Fork.ForkState.Active())
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

### 选项

| 选项       | 作用                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `name`     | 用于日志和 fork 树的名称，[按 Effect 服务键的方式构造](../best-practices/packaging/#为插件命名)。 |
| `config`   | Effect `Schema`，用于在运行 `apply` 前解码输入。不需要配置时可以省略。                            |
| `inject`   | 插件需要的服务。参见[依赖](#依赖)。                                                               |
| `provides` | 声明本地服务键或结构化契约描述，不会发布服务。                                                    |
| `overlap`  | 声明重叠运行安全性，默认 `false`。仅为元数据，不改变重启行为。                                    |
| `apply`    | 启动插件，在 fork 的 `Scope` 内运行。                                                             |
| `retry`    | 在 `apply` 或受监督任务失败后重启插件的 `Schedule`。                                              |

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

```ts import.meta.vitest name="plugins: dependencies"
import { Context, Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

class Database extends Context.Service<
	Database,
	{ readonly query: (sql: string) => Effect.Effect<ReadonlyArray<string>> }
>()("app/Database") {}

class Cache extends Context.Service<
	Cache,
	{ readonly get: (key: string) => Effect.Effect<Option.Option<string>> }
>()("app/Cache") {}

const report = Plugin.make({
	name: "app/report",
	inject: [Database, Plugin.optional(Cache)],
	apply: () =>
		Effect.gen(function* () {
			const database = yield* Database
			const cache = yield* Effect.serviceOption(Cache)
			const rows = yield* database.query("select * from sales")
			yield* Effect.log(`${rows.length} rows, cache: ${Option.isSome(cache)}`)
		}),
})

const database = Plugin.service(
	Database,
	Effect.succeed({ query: () => Effect.succeed(["north", "south"]) }),
	{ name: "database" },
)

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(report)
		yield* fork.await
		yield* Stream.runHead(fork.state) // => Option.some(Fork.ForkState.Pending({ missing: ["app/Database"] }))
		yield* Graft.plugin(database)
		yield* fork.state.pipe(
			Stream.filter(({ _tag }) => _tag !== "Pending" && _tag !== "Loading"),
			Stream.runHead,
		) // => Option.some(Fork.ForkState.Active())
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
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

```ts import.meta.vitest name="plugins: update in place"
import { Array, Effect, Ref, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// Stands in for a real server: it records the port of every start.
const starts = Ref.makeUnsafe<ReadonlyArray<number>>([])
const startServer = (port: number, banner: Ref.Ref<string>) =>
	Ref.update(starts, Array.append(port))

const server = Plugin.make({
	name: "app/server",
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

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(server, { port: 8080, banner: "Hello" })
		yield* fork.await
		yield* fork.update({ port: 8080, banner: "Welcome" })
		yield* fork.update({ port: 8081, banner: "Welcome" })
		yield* fork.stable
		yield* Ref.get(starts) // => [8080, 8081]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
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

```ts import.meta.vitest name="plugins: failures and retries"
import { Effect, Ref, Schedule, Schema, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

class ConnectionError extends Schema.TaggedError<
	ConnectionError,
	{ readonly brand: unique symbol }
>()("ConnectionError", {}) {}

// Stands in for a connection that fails on the first attempt.
const attempts = Ref.makeUnsafe(0)
const connect = Effect.flatMap(
	Ref.updateAndGet(attempts, (n) => n + 1),
	(attempt) => (attempt === 1 ? ConnectionError.make({}) : Effect.void),
)

const client = Plugin.make({
	name: "app/client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(client)
		yield* Effect.flip(fork.await) // => ConnectionError.make({})
		yield* fork.state.pipe(
			Stream.filter(Fork.ForkState.$is("Active")),
			Stream.runHead,
		)
		yield* Ref.get(attempts) // => 2
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

## 从服务和 Layer 创建插件

对于只发布服务的插件，可以使用两种简写方式。

| 简写             | 构建对象            | 发布内容                  |
| ---------------- | ------------------- | ------------------------- |
| `Plugin.service` | 一个服务            | 该服务。                  |
| `Plugin.layer`   | 一个 Effect `Layer` | `provides` 中列出的服务。 |

```ts title="database.ts"
import { Context, Effect } from "effect"

import { Plugin } from "@graftland/graft"

export class Database extends Context.Service<
	Database,
	{ readonly query: (sql: string) => Effect.Effect<ReadonlyArray<string>> }
>()("app/Database") {}

const openDatabase = Effect.acquireRelease(
	Effect.succeed({ query: () => Effect.succeed(["north", "south"]) }),
	() => Effect.log("Database closed"),
)

export const database = Plugin.service(Database, openDatabase, {
	name: "app/database",
})
```

`Plugin.layer` 为每个 fork 独立构建这个 Layer，并在 fork 停止时销毁它：

```ts import.meta.vitest name="plugins: plugin from a layer"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

import { Database, database } from "./database.ts"

class Storage extends Context.Service<
	Storage,
	{ readonly list: Effect.Effect<ReadonlyArray<string>> }
>()("app/Storage") {}

class StorageAdmin extends Context.Service<
	StorageAdmin,
	{ readonly clear: Effect.Effect<void> }
>()("app/StorageAdmin") {}

const StorageLive = Layer.mergeAll(
	Layer.effect(
		Storage,
		Effect.map(Effect.service(Database), (database) => ({
			list: database.query("select name from files"),
		})),
	),
	Layer.succeed(StorageAdmin, { clear: Effect.void }),
)

const storage = Plugin.layer(StorageLive, {
	name: "app/storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})

// Starts only once both services are published.
const files = Plugin.make({
	name: "app/files",
	inject: [Storage, StorageAdmin],
	apply: () => Effect.void,
})

await Effect.runPromise(
	Effect.gen(function* () {
		const provider = yield* Graft.plugin(database)
		yield* provider.await
		const layer = yield* Graft.plugin(storage)
		yield* layer.await
		const consumer = yield* Graft.plugin(files)
		yield* consumer.await
		yield* Stream.runHead(consumer.state) // => Option.some(Fork.ForkState.Active())
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

## 插件模块

加载器和 CLI 从模块中导入插件。

- **导出。** 模块通过默认导出或名为 `plugin` 的导出提供插件，`Plugin.fromModule`
  也按相同的方式读取。
- **无副作用。** 导入插件模块时，除了定义插件，不应执行其他操作。Graft 只能释放
  `apply` 获取的资源。
- **重载。** 自动[热重载](../hot-reload/)会重新导入受变化影响的模块；公开的
  `hmr.reload` 则强制全量重载。

## 发布插件

```sh
npm create @graftland@latest review -- --template plugin
```

[`plugin` 模板](../cli/#模板)创建一个包：它从 `src/index.ts`
导出一个插件，附带一个测试，以及通过 `npm run dev` 运行该插件的 `graft.yml`。

| 规则                                             | 原因                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命名为 `graft-plugin-<name>`                     | 用户就能用短名称 `<name>` 加载它。Graft 只会尝试 `@graftland/plugin-<name>` 和 `graft-plugin-<name>`。其他名称 `create` 会给出警告，用户必须写出完整包名。 |
| 把 `@graftland/graft` 和 `effect` 设为 peer 依赖 | 它们由应用提供，所有插件共用同一份。                                                                                                                       |
| 发布 JavaScript                                  | Node 不会剥离 `node_modules` 中的类型。`npm publish` 会先运行 `build`，把 `src` 编译到 `dist`。                                                            |

发布包需要注意的其他事项见[插件包](../best-practices/packaging/)。

## 托管条目

把条目列表字段声明为 `Entry.Entries`，并传给 `Group.Group`。

```ts
import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

export const host = Plugin.make({
	name: "host",
	config: Schema.Struct({ plugins: Entry.Entries }),
	apply: Effect.fnUntraced(function* ({ plugins }) {
		const subtree = yield* Graft.plugin(Group.Group, plugins)
		return (next) => subtree.update(next.plugins).pipe(Effect.as(true))
	}),
})
```

Graft 会补全缺失的 id，将它们写回配置文件，并用每个子插件自己的配置 Schema 校验其配置。组合后的编辑器 Schema 也会对这些列表应用已注册的子插件 Schema。

像上例一样返回更新函数，可在 Graft 首次写回 id 时保持子插件运行。没有更新函数的宿主会在这次写入后重启。身份规则见[配置项字段](../config-file/#配置项字段)。
