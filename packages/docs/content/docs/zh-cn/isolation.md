---
title: 领域与隔离
description: 为插件树的某个分支提供独立的服务和事件。
---

领域决定一个 fork 能看到哪些服务和事件。可以用它并排运行相互独立的实例，例如为每个租户提供一套服务。如果只是想修改某项设置，请参阅
[Intercept](../intercepts/)。

`Graft.plugin` 的 `isolate` 选项对该 fork 及其所有后代生效。

领域是一个进程内的**可见性**边界：它决定 fork 能看到什么，而不决定代码在哪里运行。要把插件的代码移到子进程、worker 或另一台机器上，请使用
[Remote](../remote/overview/)，它划出的是**执行**边界。两者都不限制插件代码能做什么；如需权限边界，请把 Remote 的 runner 放进容器或虚拟机。

## 领域

每个服务键和事件都归属于一个**领域（realm）**。默认情况下，整个应用只有一个领域：无论在哪里发布服务，所有插件都能看到；事件也会传递给所有处理函数。

`isolate` 选项可以针对指定的键，为一个 fork 及其所有后代创建独立的领域：

```ts import.meta.vitest name="isolation: realms"
import { Context, Effect, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Database extends Context.Service<Database, { readonly url: string }>()(
	"app/Database",
) {}

const app = Plugin.make({
	name: "app",
	inject: [Database],
	apply: () =>
		Effect.flatMap(Database, (db) => Effect.log(`app uses ${db.url}`)),
})

const tenant = Plugin.make({
	name: "tenant",
	config: Schema.Struct({ name: Schema.String }),
	apply: ({ name }) =>
		Effect.gen(function* () {
			yield* Graft.provide(Database, { url: `postgres://${name}` })
			yield* Graft.plugin(app)
		}),
})

const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(tenants)
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["app uses postgres://a"], ["app uses postgres://b"]]
```

这里每个 `tenant` fork 都可以发布自己的 `Database`。

- 每个 fork 内部的插件只能看到该 fork 的 `Database`。
- 外部发布的 `Database` 对内部不可见，反之亦然。
- 未隔离的键仍然照常共享。

`isolate` 接受任何带 `key` 的对象，可以是 `Database`
这样的服务键，也可以是[事件](../events/)。

### 共享领域

使用标签可以让多个 fork 加入同一个共享领域，而非各自使用私有领域：

```ts import.meta.vitest name="isolation: shared realms"
import { Context, Effect, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Database extends Context.Service<Database, { readonly url: string }>()(
	"app/Database",
) {}

const database = Plugin.service(
	Database,
	Effect.succeed({ url: "postgres://staging" }),
	{ name: "database" },
)

const api = Plugin.make({
	name: "api",
	inject: [Database],
	apply: () =>
		Effect.flatMap(Database, (db) => Effect.log(`api uses ${db.url}`)),
})

const worker = Plugin.make({
	name: "worker",
	inject: [Database],
	apply: () =>
		Effect.flatMap(Database, (db) => Effect.log(`worker uses ${db.url}`)),
})

const staging = Effect.gen(function* () {
	yield* Graft.plugin(database, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.provide(Database, { url: "postgres://production" })
		yield* staging
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["api uses postgres://staging"], ["worker uses postgres://staging"]]
```

无论 `api` 和 `worker` 位于树的什么位置，它们都共享 `staging` 领域的
`Database`，看不到其他领域发布的 `Database`。

标签的规则：

- 标签与服务键或事件键是身份的两个独立部分。Graft 把它们各自当作完整的字符串处理，包括内嵌的 NUL 字符。
- 以 `#` 或 `@` 开头的标签不会指向私有领域。
- 空标签表示一个共享领域，这个领域与默认的根领域不同。

### 环境兜底与继承

领域隔离的是已发布的服务，不是构建 `Graft.layer` 时环境中的服务。

| 问题                                                     | 答案                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 领域中没有某个注入键的 provision，会怎样？               | 它的消费者可以使用同键的环境值。                                                                        |
| 在领域 A 发布服务，会重启领域 B 中使用环境值的消费者吗？ | 不会，撤回服务也不会。                                                                                  |
| 父插件的 provision 会通过 Effect context 传给子插件吗？  | 不会。每个子插件必须通过自己的 `inject` 依赖，才能在自己的领域中取得 provision。                        |
| 从环境继承的值仍然可用吗？                               | 可用。如果父插件的 provision 遮蔽了根环境中的同键值，子插件可以重新使用该环境兜底，多代子插件同样如此。 |
