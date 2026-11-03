---
title: 服务
description: 在运行期间发布服务，以及 Graft 如何安全地撤回服务。
---

Graft 中的服务就是普通的 Effect `Context`
键及其对应的值。Graft 增加的能力是：在应用运行期间发布和撤回服务，并确保使用某个服务的插件在该服务释放之前停止。

## 发布服务

在 `apply` 内调用 `Graft.provide`：

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect } from "effect"

class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

const clock = Plugin.make({
	name: "clock",
	apply: () => Graft.provide(Clock, { now: Effect.sync(() => Date.now()) }),
})
```

服务归发布它的 fork 所有，在该 fork 卸载或重启前一直可用。一个 fork 可以发布任意数量的服务。

在同一个[领域（realm）](../isolation/)内，一个键只能由一个 fork 发布。再次对同一个键调用
`Graft.provide` 会以 `ServiceConflict`
失败。要切换服务实现，可以替换发布它的插件，或使用
[`Graft.replace`](../lifecycle/#替换插件)。

## 使用服务

将服务键列入 `inject`，然后通过 `yield*` 读取：

```ts
const uptime = Plugin.make({
	name: "uptime",
	inject: [Clock],
	apply: () =>
		Effect.gen(function* () {
			const clock = yield* Clock
			const started = yield* clock.now
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(clock.now, (now) =>
					Effect.log(`Ran for ${now - started} ms`),
				),
			)
		}),
})
```

上面的终结器在插件停止时调用
`clock`。这样做是安全的：在所有注入该服务的插件停止之前，服务始终可用。

## 服务撤回流程

发布服务的 fork 停止时，Graft 会依次执行以下步骤：

1. 在一个事务中撤回该 fork 发布的所有服务。此后，不再允许新的插件开始使用这些服务。
2. 等待所有正在使用这些服务的插件停止。这些插件发现依赖消失后，会停止并回到
   `Pending` 状态。
3. 关闭该 fork 的 `Scope`，执行终结器、停止子插件，并移除事件处理函数。
4. 释放该 fork 自身持有的服务使用权。

因此，无论终结器按什么顺序注册，资源都只会在没有任何调用者之后释放。如果第 2 步超过 10 秒，Graft 会记录一条警告：可能有两个插件在互相等待。

插件一旦开始使用某个服务，就会一直持有它，直到自身停止。Graft 在检查插件依赖的同一个事务中记录这些使用关系，确保服务不会在插件启动到一半时被撤回。

## 来自环境的服务

构建 `Graft.layer`
时所在环境中的服务对所有插件可见。它们和插件发布的服务一样可以满足 `inject`
声明，但永远不会被撤回：

```ts
import { NodeServices } from "@effect/platform-node"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

使用这个 Layer 后，插件可以直接注入 `FileSystem.FileSystem` 或
`Path.Path`。与整个应用生命周期一致的服务适合放在环境中。
