---
title: 掛載
description: 把一個 Layer 放進圖裡，並在它的相依項目可用期間讓它保持執行。
---

`Graft.mount` 把一個 `Layer` 放進圖裡。`requires`
清單中的每個項目都可用時，這個 Layer 被建置，它的服務隨之發布。

## 掛載一個 Layer

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

| 引數   | 內容                                                          |
| ------ | ------------------------------------------------------------- |
| 第一個 | Layer。任何輸入型別能被 `requires` 清單涵蓋的 Layer。         |
| 第二個 | 選項：`name`、`requires`、`retry`、`isolate` 與 `intercept`。 |

掛載屬於目前 scope。關閉該 scope 就會卸載它；在某個 Layer 裡建立的掛載，是該掛載的子掛載。見[生命週期](../lifecycle/)。

## 宣告 Layer 需要什麼

`requires`
列出 Layer 從圖裡讀取的服務。編譯器把它與 Layer 的輸入型別對照，所以需要某個服務的 Layer 無法在未列出它的情況下掛載。

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

- 必要項目不可用時，掛載保持 `Pending`，直到它可用。
- `Graft.optional(key)` 不阻塞建置。該項目出現或消失時，掛載會重建。
- 可選項目用 `Effect.serviceOption` 讀取，絕不要用 `yield* key`。

## 發布 Layer 提供的東西

Graft 發布 Layer 輸出內容中的每個服務。你不需要列出提供了哪些鍵；Layer 的型別就是清單。

用 `Layer.provide` 組合內部相依，而不是 `Layer.provideMerge`。`provideMerge`
會把它們留在輸出裡，Graft 也會發布它們，於是同一領域裡另一個掛載會以
`ServiceConflict` 失敗。

Effect 內部的 `Layer.CurrentMemoMap` 不會被發佈，即使 Layer 輸出了它。

- 兩個掛載不能在同一領域裡發布同一個鍵。第二次建置會以 `Graft.ServiceConflict`
  失敗；見[隔離](../isolation/)。
- 已發布的服務持續到掛載被拆除或重建為止。
- 重建先撤回舊服務，等待它們的消費者，然後發布新的服務。

## 選擇選項

| 選項        | 型別                                                | 作用                                                                |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `name`      | `string`                                            | 在掛載樹和日誌註解中的名稱。預設為 `"layer"`。                      |
| `requires`  | `ReadonlyArray<Dependency>`                         | 決定建置是否開始的項目。見上文。                                    |
| `retry`     | `Schedule`                                          | 依此排程重建失敗的掛載。見[失敗與重試](../failures-retry/)。        |
| `isolate`   | `ReadonlyArray<Isolatable \| [Isolatable, string]>` | 給這些服務自己的領域。見[隔離](../isolation/)。                     |
| `intercept` | `ReadonlyArray<Intercept>`                          | 為這個掛載及其子掛載調整 Reference。見[Intercept](../intercepts/)。 |

## 持有掛載

`Graft.mount` 回傳一個 `Mount`：

| 成員      | 型別                         | 用途                                                             |
| --------- | ---------------------------- | ---------------------------------------------------------------- |
| `state`   | `Stream<MountState>`         | 目前狀態及之後的每次變化，以 `Unmounted` 結束。                  |
| `await`   | `Effect<void, E>`            | 等到穩定（不再是 `Loading`）；`Failed` 狀態以它的 `Cause` 失敗。 |
| `stable`  | `Effect<void>`               | 等這個掛載及其子掛載都不再處於 `Loading`。                       |
| `restart` | `Effect<void>`               | 拆除後重新建置，即使什麼都沒變。                                 |
| `unmount` | `Effect<void, CleanupError>` | 拆除這個掛載及其下面的一切。                                     |

`await` 等到掛載穩定：第一個不是 `Loading` 的狀態。`Pending` 算作穩定。`Failed`
狀態會讓 `await` 以它的 `Cause` 失敗，即使設定了 `retry` 也是如此：第一次
`Failed` 就結束 `await`，之後的重試在背景繼續。用 `state` 觀察它們，或再次呼叫
`await`。

用 `Stream.runHead`
讀取一個狀態，或跟隨整條串流。見[生命週期](../lifecycle/#掛載狀態)。

## 來自環境的服務

建置 `Graft.layer`
時的環境裡的服務，對每個掛載都可見，並且在不需要發布的情況下滿足 `requires`：

```ts
import { FileSystem, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

export const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

掛載仍然觀察自己的領域：同一個鍵的發布出現時，掛載用發布的值重建；發布被撤回時再次重建。圖裡的服務優先於環境。
