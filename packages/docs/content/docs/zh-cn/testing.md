---
title: 测试
description: 让每个测试运行在全新的图里，并在不打开端口的情况下测试远程连接。
---

测试设计承诺的行为：哪些挂载到达
`Active`，哪些服务被发布，什么以什么顺序被拆除，哪些失败会被重试。每个测试都得到一张全新的图。

## 每个测试一张全新的图

```ts
import { Context, Effect, Layer, type Scope } from "effect"
import { expect, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

it.effect("publishes a config value", () =>
	run(
		Effect.gen(function* () {
			const publication = yield* Graft.publish(Region, "eu")
			yield* publication.await
			const value = yield* Graft.await(Region)
			expect(value).toBe("eu")
		}),
	),
)
```

| 规则                       | 原因                                             |
| -------------------------- | ------------------------------------------------ |
| `Layer.fresh(Graft.layer)` | 测试之间共享的图会让挂载和发布继续存活。         |
| 最外层的 `Effect.scoped`   | 它在测试期间让挂载存活，并在测试结束后卸载它们。 |
| `it.effect`                | 它提供运行时和 `TestContext`。                   |

## 对状态断言

读取
`mount.state`，等待测试关心的那个状态。不要只读一次快照，就假定挂载已经稳定。

```ts
import { Effect, Option, Stream } from "effect"

import { Mount } from "@graftland/graft"

export const reached = (mount: Mount.Mount, tag: Mount.MountState["_tag"]) =>
	mount.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.die(new Error(`Mount ended before ${tag}`)),
				onSome: () => Effect.succeed(true),
			}),
		),
	)
```

- 用 `mount.await` 表示“已稳定”，用 `mount.stable`
  表示“这个挂载下面没有正在加载的东西”。
- 把启动和停止事件记录进 `Ref`，用来断言拆除顺序。
- 通过 `Graft.use` 或 `Graft.await` 读取服务，以测试消费者视角。

## 时间与重试

提供 `TestContext`，并用 `TestClock` 推进时钟。这样带
`retry: Schedule.exponential(...)` 的挂载无需真实等待就能重试。

## 在内存中测试远程连接

`testing` 入口提供一对 `effect/rpc`
Protocol，它们永远不会变成字节。消息仍然经过正常的编码和解码路径，连接也可以按需结束。

```ts import.meta.vitest name="testing: call and disconnect in memory"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"

import * as Testing from "@graftland/graft/testing"

const Add = Rpc.make("Add", {
	payload: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
	success: Schema.Finite,
})

const Calculator = RpcGroup.make(Add)

const sum = await Effect.runPromise(
	Effect.gen(function* () {
		const protocol = yield* Testing.make
		const server = yield* Layer.build(
			Layer.merge(
				protocol.server,
				Calculator.toLayer({
					Add: ({ a, b }) => Effect.succeed(a + b),
				}),
			),
		)
		yield* RpcServer.make(Calculator).pipe(
			Effect.provideContext(server),
			Effect.forkScoped,
		)
		const client = yield* RpcClient.make(Calculator).pipe(
			Effect.provideServiceEffect(RpcClient.Protocol, protocol.client),
		)
		return yield* client.Add({ a: 1, b: 2 })
	}).pipe(Effect.scoped),
)
sum // => 3
```

| 成员         | 用途                                            |
| ------------ | ----------------------------------------------- |
| `make`       | 创建 Protocol 对；属于当前 scope。              |
| `server`     | 服务端 Protocol 的 Layer，传给 `Remote.serve`。 |
| `client`     | 打开一条连接；每次运行都打开独立的一条。        |
| `disconnect` | 结束当前连接，并让进行中的调用失败。            |

因为 `client` 每次运行都打开新的连接，带 `retry`
的挂载会重新连上内存中的服务端，所以无需端口就能测试重连行为。在测试里返回
`disconnect`，即可检查远程服务被撤回并再次发布。
