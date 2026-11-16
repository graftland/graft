---
title: 測試
description: 讓每個測試執行在全新的圖裡，並在不開啟連接埠的情況下測試遠端連線。
---

測試設計承諾的行為：哪些掛載到達
`Active`，哪些服務被發布，什麼以什麼順序被拆除，哪些失敗會被重試。每個測試都得到一張全新的圖。

## 每個測試一張全新的圖

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

| 規則                       | 原因                                             |
| -------------------------- | ------------------------------------------------ |
| `Layer.fresh(Graft.layer)` | 測試之間共用的圖會讓掛載和發布繼續存活。         |
| 最外層的 `Effect.scoped`   | 它在測試期間讓掛載存活，並在測試結束後卸載它們。 |
| `it.effect`                | 它提供執行階段和 `TestContext`。                 |

## 對狀態斷言

讀取
`mount.state`，等待測試關心的那個狀態。不要只讀一次快照，就假定掛載已經穩定。

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

- 用 `mount.await` 表示「已穩定」，用 `mount.stable`
  表示「這個掛載下面沒有正在載入的東西」。
- 把啟動和停止事件記錄進 `Ref`，用來斷言拆除順序。
- 透過 `Graft.use` 或 `Graft.await` 讀取服務，以測試消費者視角。

## 時間與重試

提供 `TestContext`，並用 `TestClock` 推進時鐘。這樣帶
`retry: Schedule.exponential(...)` 的掛載無需真實等待就能重試。

## 在記憶體中測試遠端連線

`testing` 入口提供一對 `effect/rpc`
Protocol，它們永遠不會變成位元組。訊息仍然經過正常的編碼和解碼路徑，連線也可以按需結束。

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

| 成員         | 用途                                            |
| ------------ | ----------------------------------------------- |
| `make`       | 建立 Protocol 對；屬於目前 scope。              |
| `server`     | 服務端 Protocol 的 Layer，傳給 `Remote.serve`。 |
| `client`     | 開啟一條連線；每次執行都開啟獨立的一條。        |
| `disconnect` | 結束目前連線，並讓進行中的呼叫失敗。            |

因為 `client` 每次執行都開啟新的連線，帶 `retry`
的掛載會重新連上記憶體中的服務端，所以無需連接埠就能測試重連行為。在測試裡回傳
`disconnect`，即可檢查遠端服務被撤回並再次發布。
