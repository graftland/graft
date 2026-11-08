---
title: 服務
description: 在執行期間發布服務，以及 Graft 如何安全地撤回服務。
---

Graft 中的服務就是一般的 Effect `Context` 鍵及其對應的值。Graft 增加了兩點保證：

- 服務可以在應用程式執行期間發布和撤回。
- 使用某個服務的外掛會在該服務消失之前停止。

## 發布服務

在 `apply` 內呼叫 `Graft.provide`：

```ts title="clock.ts"
import { Context, DateTime, Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

export class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

export const clock = Plugin.make({
	name: "app/clock",
	apply: () =>
		Graft.provide(Clock, {
			now: Effect.map(DateTime.now, DateTime.toEpochMillis),
		}),
})
```

| 規則       | 細節                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| **歸屬**   | 服務歸發布它的 fork 所有，在該 fork 卸載或重新啟動前一直可用。         |
| **數量**   | 一個 fork 可以發布任意數量的服務。                                     |
| **唯一性** | 在同一個[領域（realm）](../isolation/)內，一個鍵只能由一個 fork 發布。 |
| **衝突**   | 再次對同一個鍵呼叫 `Graft.provide` 會以 `ServiceConflict` 失敗。       |
| **切換**   | 取代發布它的外掛。                                                     |

## 使用服務

將服務鍵列入 `inject`，然後透過 `yield*` 讀取：

```ts import.meta.vitest name="services: use a service"
import { Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

import { Clock, clock } from "./clock.ts"

const uptime = Plugin.make({
	name: "app/uptime",
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

const state = await Effect.runPromise(
	Effect.gen(function* () {
		const provider = yield* Graft.plugin(clock)
		yield* provider.await
		const fork = yield* Graft.plugin(uptime)
		yield* fork.await
		return yield* Stream.runHead(fork.state)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
state // => Option.some(Fork.ForkState.Active())
```

上面的終結器在外掛停止時呼叫
`clock`。這樣做是安全的：在所有注入該服務的外掛停止之前，服務始終可用。

發布方不一定在你的行程裡執行。用 [Remote](../remote/overview/)
移到子行程、worker 或另一台機器上的外掛，仍然在這裡發布它的服務，`uptime`
也照樣注入
`Clock`。只是呼叫會經過一條連線，失敗時呼叫端看到的是[遠端錯誤](../units/)。

## 服務撤回流程

發布服務的 fork 停止時，Graft 依序執行以下步驟：

1. 如果 `apply` 仍在執行，**先停止它**。
2. **關閉發布。**
   在一筆交易中撤回該 fork 的服務。此後新的消費者不能取得 lease，該 activation 也不能再發布服務。
3. **排空消費者。**
   等待既有消費者釋放全部 lease，然後重新啟動這些消費者（見下表）。期間健康的
   `Plugin.fork` 任務及其資源繼續服務消費者的 finalizer。
4. **停止剩餘任務。** 關閉它們的 Scope，並等待取消清理完成。
5. **關閉 activation Scope。** 執行終結器、停止子外掛並移除事件處理函式。
6. **釋放**該 fork 自身使用的服務。

第 3 步中消費者如何重新啟動：

| 消費者的情況         | 重新啟動後                     |
| -------------------- | ------------------------------ |
| 有環境後備值         | 使用後備值。                   |
| 必要相依，沒有後備值 | 進入 `Pending`。               |
| 可選相依，沒有後備值 | 在缺少該服務的情況下重新啟動。 |

:::note

第 3 步超過 10 秒時，Graft 會記錄警告：可能有兩個外掛在互相等待。終結器的註冊順序無關緊要；健康任務的資源和 activation 的資源會一直保持存活，直到持有 lease 的消費者結束。

:::

### 失敗觸發清理時

遵循相同的順序。失敗的任務已經停止，健康任務繼續執行，直到消費者排空。

- Graft 會收集排空期間出現的其他任務失敗，並記錄它們的完整
  `Cause`，包括清理 defect。
- 由失敗觸發的清理會將這些失敗納入最終的 `Failed` 狀態，資源終結器的失敗也一樣。
- 這些失敗不會中斷後續清理階段，也不會妨礙相依 lease 的釋放。
- 明確呼叫 `dispose` 時，會以 `Fork.CleanupError` 回報清理失敗，其 `cause`
  保留原始失敗原因。

無法可靠歸因的終結器中斷仍作為清理失敗保留完整 cause；取消不證明清理成功。

### Lease

Graft 在檢查外掛相依項目的同一筆交易中記錄使用關係，因此服務不會在外掛啟動到一半時被撤回。

每一**代**對同一個 provision 只持有一份 lease，重複注入不會重複計數。重疊執行的兩代各自持有 lease。舊代的結算與清理不會刪除新代的 lease 或發布；環檢查包含所有仍持有 lease 的代，包括已撤回發布的舊代。

## 來自環境的服務

建構 `Graft.layer` 時所在環境中的服務對所有外掛可見。它們可以滿足 `inject`
宣告，生命週期與該環境一致。與整個應用程式生命週期一致的服務適合放在環境中：

```ts import.meta.vitest name="services: services from the environment"
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Fork, Graft, Plugin } from "@graftland/graft"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)

const files = Plugin.make({
	name: "app/files",
	inject: [FileSystem.FileSystem, Path.Path],
	apply: () => Effect.void,
})

const state = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(files)
		yield* fork.await
		return yield* Stream.runHead(fork.state)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)
state // => Option.some(Fork.ForkState.Active())
```

使用這個 Layer 後，外掛可以直接注入 `FileSystem.FileSystem` 或 `Path.Path`。

### 查找順序

對於 `inject` 中的每個鍵，無論必要或可選，Graft 都依下列順序解析：

1. 消費者所在領域的註冊表。
2. 註冊表中沒有時，使用環境。

使用後備值的消費者仍會監看自己的領域：

| 領域中的事件       | 消費者……                 |
| ------------------ | ------------------------ |
| 出現新的 provision | 重新啟動並改用發布的值。 |
| provision 被撤回   | 重新啟動並回到環境值。   |

因此，無論先載入消費者還是先發布服務，消費者最終都會使用相同的值。發布操作不會等待既有消費者完成重新啟動。

### `inject` 與 `Effect.serviceOption`

|                         | `inject` | 未宣告的 `Effect.serviceOption`  |
| ----------------------- | -------- | -------------------------------- |
| 先查找領域，再查找環境  | 是       | 否，只讀取 activation 的 context |
| 訂閱註冊表變化          | 是       | 否                               |
| 取得 provision 的 lease | 是       | 否                               |

需要這種查找和重新啟動行為時，請使用 `inject`。

### Reference

`inject` 中的 `Context.Reference` 始終有後備值，因此不會讓外掛停在
`Pending`。解析順序：

1. 消費者所在領域的 provision。
2. 繼承的 Reference 值（包含 intercept）。
3. Reference 的預設值。

它和其他注入鍵一樣監看發布與撤回。

## 發布導致的相依環

Graft 會拒絕會導致發布者自身重新啟動的發布。它在發布服務的同一筆交易中進行檢查：

1. 找出在同一領域中，透過 ambient 後備值或缺席的可選相依監看該鍵的執行中消費者。
2. 沿著這些消費者的子樹、受影響 provider 的消費者擴展，直到不再有 fork 會被停止。
3. 如果發布者也在其中，註冊表保持不變，`Graft.provide` 以 `ServiceConflict`
   失敗。

`Pending` fork 的必要相依是在等待啟動，不屬於重新啟動的 watcher。

### 錯誤

| 欄位     | 值                                                          |
| -------- | ----------------------------------------------------------- |
| `reason` | 直接環為 `"SelfDependency"`，間接環為 `"DependencyCycle"`。 |
| `reason` | 相依項目的變更已使提供者失效時為 `"Invalidated"`。          |
| `fork`   | 發布者的 fork ID。                                          |
| `realm`  | 服務所在的領域。                                            |

包裝環境服務時，請為輸入和輸出使用不同的鍵。

### 接下來會發生什麼

- 如果環錯誤從 `apply` 或 `Plugin.fork`
  任務傳播出來，Graft 會清理發布者，發布者進入 `Failed`。
- 隨後它等待設定、相依項目或圖發生變化，而不會依 retry
  schedule 反覆撞上同一個環。
- 重試之前，Graft 會先把失敗 fork 預期取得的相依項目放回圖中再做檢查。清理期間釋放 fork 的 lease，本身並不能解除環。
- 拒絕發布不會寫入服務值，也不會觸發既有 watcher 重新啟動。正常的失敗傳播仍然適用：等待子外掛失敗的外掛可能隨之失敗；失敗的 fork 之前已發布的服務被撤回時，其消費者仍會受到影響。
