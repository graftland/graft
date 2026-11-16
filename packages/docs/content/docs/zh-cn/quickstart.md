---
title: 快速开始
description: 在运行期间挂载一个 Effect Layer，并在程序运行时改变它。
---

Graft 是一个 Effect 库，不是一个工具。你把它加入一个已经构建运行时的程序，在那里挂载 Layer。

## 安装

```sh
npm install effect @graftland/graft
```

`effect` 是 peer 依赖；Graft 需要 `4.1.*` 版本。

## 挂载一个 Layer

把 `Graft.layer`
提供给程序，它会随运行时一起关闭，并卸载所有挂载。挂载属于创建它的那个 scope。

```ts title="app.ts"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

export class Greeting extends Context.Service<Greeting, string>()(
	"app/Greeting",
) {}

const greeting = Layer.effect(Greeting, Effect.succeed("Hello"))

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(greeting, { name: "greeting" })
	yield* mount.await
	yield* Effect.log("The greeting is available")
})

// @effect-diagnostics-next-line strictEffectProvide:off -- main provides the graph once, at the application entry point
const main = program.pipe(Effect.scoped, Effect.provide(Graft.layer))
```

和任何 Effect 程序一样，用 `Effect.runPromise` 运行它，或放进
`ManagedRuntime`。`mount.await` 等到挂载稳定；构建失败时以它的 `Cause`
失败。最外层的 `scoped` 结束时，Layer 被拆除。

## 发布一个值并重建

配置不是特殊概念。用 `Graft.publish`
把它作为一个服务发布出去，修改值时，所有需要它的挂载都会重建。

```ts import.meta.vitest name="quickstart: rebuild on a new value"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

class Banner extends Context.Service<Banner, string>()("app/Banner") {}

const banner = Layer.effect(
	Banner,
	Effect.map(Region, (region) => `Serving ${region}`),
)

const states = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.publish(Region, "eu").pipe(
			Effect.flatMap((publication) => publication.await),
		)
		const mount = yield* Graft.mount(banner, {
			name: "banner",
			requires: [Region],
		})
		yield* mount.await
		return yield* Stream.runHead(mount.state)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
states // => Option.some(Mount.MountState.Active())
```

| 步骤                    | 发生什么                                             |
| ----------------------- | ---------------------------------------------------- |
| `Graft.publish`         | 值成为一个服务，其他挂载可以在 `requires` 中使用它。 |
| 在 `requires` 中挂载    | `Region` 可用后，Layer 被构建。                      |
| `publication.set("us")` | Banner 被拆除，再用新的 region 重新构建。            |
| 关闭 scope              | 挂载和发布都被移除。                                 |

`requires`
列表必须覆盖 Layer 的输入类型；不满足的列表会被编译器拒绝。见[挂载](../mounting/)和[发布](../publications/)。

## 接下来读什么

| 我想……                   | 阅读                             |
| ------------------------ | -------------------------------- |
| 理解图、挂载和发布       | [核心概念](../concepts/)         |
| 停止和重启一个挂载       | [生命周期](../lifecycle/)        |
| 随服务的出现和消失读取它 | [服务可用性](../availability/)   |
| 处理构建失败的 Layer     | [失败与重试](../failures-retry/) |
| 把服务提供给另一个进程   | [远程服务](../remote/)           |
