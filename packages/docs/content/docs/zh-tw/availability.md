---
title: 服務可用性
description: 在服務已發布時讀取它，並在撤回時停止工作。
---

服務可以在應用程式執行期間出現和消失。四個操作無需掛載 Layer，就能從圖裡讀取服務並對這種變化做出反應。

| 操作                           | 結果                     | 服務被撤回時                         |
| ------------------------------ | ------------------------ | ------------------------------------ |
| `Graft.watch(key)`             | `Stream<Option<S>>`      | 送出 `Option.none()`                 |
| `Graft.await(key)`             | 服務發布後的 `Effect<S>` | 下一次讀取可能找不到它               |
| `Graft.use(key, f)`            | 帶著值執行一次 `f`       | 中斷 `f`，以 `ServiceWithdrawn` 失敗 |
| `Graft.whileAvailable(key, f)` | 每個值都執行一次 `f`     | 中斷 `f`，等下一個值再執行           |

這些操作讀取圖裡發布的服務。它們看不到只存在於建置 `Graft.layer`
時的環境裡的服務。

## 觀察一個服務

```ts
import { Context, Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const regions = Graft.watch(Region).pipe(
	Stream.map((region) => (region._tag === "Some" ? region.value : "none")),
)
```

`watch` 先立即送出目前的可用性，可能是
`None`；此後每當目前 provision 的身分改變，就送出一幀。它持有一個槽位，所以沒有值時身分也不會遺失。用它顯示狀態，或對設定變化做出反應。

## 用一次服務做一件事

`Graft.use`
等待服務、持有租約，然後執行你的 effect。如果服務先被撤回，effect 被中斷，`use`
以 `Graft.ServiceWithdrawn` 失敗。

```ts import.meta.vitest name="availability: use a published service"
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		return yield* Graft.use(Region, (region) => Effect.succeed(`in ${region}`))
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "in eu"
```

租約讓撤回等待：持有它的服務的每個 `use`
都完成之前，提供者不會被拆除。需要該服務的掛載同樣適用。

## 在服務可用期間執行

`Graft.whileAvailable` 為每個發布的值啟動一次 `f`。撤回會中斷
`f`；服務再次發布時，`f` 用新的值再執行一次。

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const program = Graft.whileAvailable(Region, (region) =>
	Effect.log(`Serving ${region}`),
)
```

| 如果 `f`…… | 那麼                                   |
| ---------- | -------------------------------------- |
| 完成       | 它等待下一個值。                       |
| 失敗       | `whileAvailable` 以該錯誤失敗並停止。  |
| 被撤回     | 它被中斷，下一次值到來時開始新的一輪。 |

## 等待一個服務

`Graft.await`
等到服務被發布並回傳它。它之後不再持有服務：呼叫回傳後，服務可能馬上被撤回。需要讓工作保住服務時，用
`use` 或 `whileAvailable`。

## 選擇操作

| 我想……                 | 使用                           |
| ---------------------- | ------------------------------ |
| 顯示服務是否存在       | `watch`                        |
| 讀一個值然後放掉       | `await`                        |
| 做一件需要該服務的任務 | `use`                          |
| 只要它存在就一直做下去 | `whileAvailable`               |
| 建置需要該服務的 Layer | 帶 `requires` 的 `Graft.mount` |

掛載透過 `requires` 和租約獲得同樣的保證；見[生命週期](../lifecycle/)。
