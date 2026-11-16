---
title: 快速開始
description: 在執行期間掛載一個 Effect Layer，並在程式執行時改變它。
---

Graft 是一個 Effect 程式庫，不是一個工具。你把它加入一個已經建置執行階段的程式，在那裡掛載 Layer。

## 安裝

```sh
npm install effect @graftland/graft
```

`effect` 是 peer 相依項目；Graft 需要 `4.1.*` 版本。

## 掛載一個 Layer

把 `Graft.layer`
提供給程式，它會隨執行階段一起關閉，並卸載所有掛載。掛載屬於建立它的那個 scope。

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

和任何 Effect 程式一樣，用 `Effect.runPromise` 執行它，或放進
`ManagedRuntime`。`mount.await` 等到掛載穩定；建置失敗時以它的 `Cause`
失敗。最外層的 `scoped` 結束時，Layer 被拆除。

## 發布一個值並重建

設定不是特殊概念。用 `Graft.publish`
把它當作一個服務發布出去，修改值時，所有需要它的掛載都會重建。

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

| 步驟                    | 發生什麼                                             |
| ----------------------- | ---------------------------------------------------- |
| `Graft.publish`         | 值成為一個服務，其他掛載可以在 `requires` 中使用它。 |
| 在 `requires` 中掛載    | `Region` 可用後，Layer 被建置。                      |
| `publication.set("us")` | Banner 被拆除，再用新的 region 重新建置。            |
| 關閉 scope              | 掛載和發布都被移除。                                 |

`requires`
清單必須涵蓋 Layer 的輸入型別；不滿足的清單會被編譯器拒絕。見[掛載](../mounting/)和[發布](../publications/)。

## 接下來讀什麼

| 我想……                   | 閱讀                             |
| ------------------------ | -------------------------------- |
| 理解圖、掛載和發布       | [核心概念](../concepts/)         |
| 停止和重新啟動一個掛載   | [生命週期](../lifecycle/)        |
| 隨服務的出現和消失讀取它 | [服務可用性](../availability/)   |
| 處理建置失敗的 Layer     | [失敗與重試](../failures-retry/) |
| 把服務提供給另一個行程   | [遠端服務](../remote/)           |
