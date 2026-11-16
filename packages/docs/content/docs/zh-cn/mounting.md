---
title: 挂载
description: 把一个 Layer 放进图里，并在它的依赖可用期间让它保持运行。
---

`Graft.mount` 把一个 `Layer` 放进图里。`requires`
列表中的每个条目都可用时，这个 Layer 被构建，它的服务随之发布。

## 挂载一个 Layer

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Pricing extends Context.Service<Pricing, string>()("app/Pricing") {}

const pricing = Layer.effect(
	Pricing,
	Effect.map(Database, (database) => `prices from ${database}`),
)

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(pricing, {
		name: "pricing",
		requires: [Database],
	})
	yield* mount.await
})
```

| 参数   | 内容                                                          |
| ------ | ------------------------------------------------------------- |
| 第一个 | Layer。任何输入类型能被 `requires` 列表覆盖的 Layer。         |
| 第二个 | 选项：`name`、`requires`、`retry`、`isolate` 与 `intercept`。 |

挂载属于当前 scope。关闭该 scope 就会卸载它；在某个 Layer 里创建的挂载，是该挂载的子挂载。见[生命周期](../lifecycle/)。

## 声明 Layer 需要什么

`requires`
列出 Layer 从图里读取的服务。编译器把它与 Layer 的输入类型对照，所以需要某个服务的 Layer 无法在未列出它的情况下挂载。

```ts title="pricing.ts"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Cache extends Context.Service<Cache, string>()("app/Cache") {}
class Pricing extends Context.Service<Pricing, string>()("app/Pricing") {}

export const pricing = Layer.effect(
	Pricing,
	Effect.gen(function* () {
		const database = yield* Database
		const cache = yield* Effect.serviceOption(Cache)
		return cache._tag === "Some" ? `${database} with ${cache.value}` : database
	}),
)

export const mount = Graft.mount(pricing, {
	name: "pricing",
	requires: [Database, Graft.optional(Cache)],
})
```

- 必需条目不可用时，挂载保持 `Pending`，直到它可用。
- `Graft.optional(key)` 不阻塞构建。该条目出现或消失时，挂载会重建。
- 可选条目用 `Effect.serviceOption` 读取，绝不要用 `yield* key`。

## 发布 Layer 提供的东西

Graft 发布 Layer 输出上下文里的每个服务。你不需要列出提供了哪些键；Layer 的类型就是列表。

用 `Layer.provide` 组合内部依赖，而不是 `Layer.provideMerge`。`provideMerge`
会把它们留在输出里，Graft 也会发布它们，于是同一领域里另一个挂载会以
`ServiceConflict` 失败。

Effect 内部的 `Layer.CurrentMemoMap` 不会被发布，即使 Layer 输出了它。

- 两个挂载不能在同一领域里发布同一个键。第二次构建会以 `Graft.ServiceConflict`
  失败；见[隔离](../isolation/)。
- 已发布的服务持续到挂载被拆除或重建为止。
- 重建先撤回旧服务，等待它们的消费者，然后发布新的服务。

## 选择选项

| 选项        | 类型                                                | 作用                                                                |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `name`      | `string`                                            | 在挂载树和日志注解中的名称。默认为 `"layer"`。                      |
| `requires`  | `ReadonlyArray<Dependency>`                         | 决定构建是否开始的条目。见上文。                                    |
| `retry`     | `Schedule`                                          | 按此计划重建失败的挂载。见[失败与重试](../failures-retry/)。        |
| `isolate`   | `ReadonlyArray<Isolatable \| [Isolatable, string]>` | 给这些服务自己的领域。见[隔离](../isolation/)。                     |
| `intercept` | `ReadonlyArray<Intercept>`                          | 为这个挂载及其子挂载调整 Reference。见[Intercept](../intercepts/)。 |

## 持有挂载

`Graft.mount` 返回一个 `Mount`：

| 成员      | 类型                         | 用途                                                             |
| --------- | ---------------------------- | ---------------------------------------------------------------- |
| `state`   | `Stream<MountState>`         | 当前状态及之后的每次变化，以 `Unmounted` 结束。                  |
| `await`   | `Effect<void, E>`            | 等到稳定（不再是 `Loading`）；`Failed` 状态以它的 `Cause` 失败。 |
| `stable`  | `Effect<void>`               | 等这个挂载及其子挂载都不再处于 `Loading`。                       |
| `restart` | `Effect<void>`               | 拆除后重新构建，即使什么都没变。                                 |
| `unmount` | `Effect<void, CleanupError>` | 拆除这个挂载及其下面的一切。                                     |

`await` 等到挂载稳定：第一个不是 `Loading` 的状态。`Pending` 算作稳定。`Failed`
状态会让 `await` 以它的 `Cause` 失败，即使设置了 `retry` 也是如此：第一次
`Failed` 就结束 `await`，之后的重试在后台继续。用 `state` 观察它们，或再次调用
`await`。

用 `Stream.runHead`
读取一个状态，或跟随整条流。见[生命周期](../lifecycle/#挂载状态)。

## 来自环境的服务

构建 `Graft.layer`
时的环境里的服务，对每个挂载都可见，并且在不需要发布的情况下满足 `requires`：

```ts
import { FileSystem, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

export const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

挂载仍然观察自己的领域：同一个键的发布出现时，挂载用发布的值重建；发布被撤回时再次重建。图里的服务优先于环境。
