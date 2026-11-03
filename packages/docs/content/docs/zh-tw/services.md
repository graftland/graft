---
title: 服務
description: 在執行期間發布服務，以及 Graft 如何安全地撤回服務。
---

Graft 中的服務就是一般的 Effect `Context`
鍵及其對應的值。Graft 增加了兩點能力：可以在應用程式執行期間發布和撤回服務；使用某個服務的外掛會在該服務釋放之前停止。

## 發布服務

在 `apply` 內呼叫 `Graft.provide`：

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

服務歸發布它的 fork 所有，在該 fork 卸載或重新啟動前一直可用。一個 fork 可以發布任意數量的服務。

在同一個[領域（realm）](../isolation/)內，一個鍵只能由一個 fork 發布。再次對同一個鍵呼叫
`Graft.provide` 會以 `ServiceConflict`
失敗。要切換服務實作，可以取代發布它的外掛，或使用
[`Graft.replace`](../lifecycle/#取代外掛)。

## 使用服務

將服務鍵列入 `inject`，然後透過 `yield*` 讀取：

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

上面的終結器在外掛停止時呼叫
`clock`。這樣做是安全的：在所有注入該服務的外掛停止之前，服務始終可用。

## 服務撤回流程

發布服務的 fork 停止時，Graft 依序執行以下步驟：

1. 如果 `apply` 仍在執行，先停止它。
2. 在一筆交易中關閉發布並撤回該 fork 的服務。此後新的消費者不能取得 lease，該 activation 也不能再發布服務。
3. 等待既有消費者釋放全部 lease。期間健康的 `Plugin.fork`
   任務及其資源繼續服務消費者的 finalizer。隨後消費者重新啟動：若有環境後備值，消費者使用它重新啟動；否則，有必要相依的消費者進入
   `Pending`，有可選相依的消費者則在缺少該服務的情況下重新啟動。
4. 停止剩餘的受監督任務並關閉其 Scope，等待取消清理完成。
5. 關閉 activation Scope，執行終結器、停止子外掛並移除事件處理函式。
6. 釋放該 fork 自身持有的相依 lease。

任務失敗觸發的清理也遵循這一順序。失敗的任務已經停止，健康任務繼續執行，直到消費者排空。Graft 會收集排空期間出現的其他任務失敗，並記錄它們的完整 Cause，包括清理 defect。由失敗觸發的清理會將這些 Cause 納入最終的
`Failed`
狀態。資源終結器的失敗也會納入其中，不會中斷後續清理階段，也不會妨礙相依 lease 的釋放。明確呼叫
`dispose` 時，會以 `Fork.CleanupError` 回報清理失敗，其 `cause`
保留原始失敗原因。

關閉期間，健康任務的資源和 activation 的資源會一直保持存活，直到持有 lease 的消費者結束，與終結器的註冊順序無關。第 3 步超過 10 秒時，Graft 會記錄警告：可能有兩個外掛在互相等待。

外掛一旦開始使用某個服務，就會一直持有它，直到自身停止。Graft 在檢查外掛相依項目的同一筆交易中記錄這些使用關係，因此服務不會在外掛啟動到一半時被撤回。

## 來自環境的服務

建構 `Graft.layer` 時所在環境中的服務對所有外掛可見。它們可以滿足 `inject`
宣告，生命週期與該環境一致：

```ts
import { NodeServices } from "@effect/platform-node"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

使用這個 Layer 後，外掛可以直接注入 `FileSystem.FileSystem` 或
`Path.Path`。與整個應用程式生命週期一致的服務適合放在環境中。

對於 `inject`
中的每個鍵，Graft 先在消費者所在領域的註冊表中查找；找不到時，才使用環境值。必要和可選相依遵循相同規則。使用環境後備值的消費者仍會監看自己的領域：同鍵 provision 出現時，消費者重新啟動並改用發布值；provision 被撤回後，消費者再次重新啟動並回到環境值。因此，無論先載入消費者還是先發布服務，消費者最終都會使用相同的值。發布操作不會等待既有消費者完成重新啟動。

需要這種查找和重新啟動行為時，請使用 `inject`。透過 `Effect.serviceOption`
讀取未宣告的鍵只會讀取 activation 的 context，不會訂閱註冊表變化，也不會取得 provision 的 lease。

`inject` 中的 `Context.Reference` 始終有後備值，因此不會讓外掛停在
`Pending`。消費者所在領域的 provision 優先；否則 Graft 使用繼承的 Reference 值（包含 intercept），或 Reference 的預設值。它和其他注入鍵一樣監看發布與撤回。

## 發布導致的相依環

如果一次發布會導致發布者自身重新啟動，Graft 會拒絕它。Graft 在發布服務的同一筆交易中進行檢查。它先找出在同一領域中透過 ambient 後備值或缺席的可選相依監看該鍵的執行中消費者，再沿著這些消費者的子樹、受影響 provider 的消費者擴展，直到不再有 fork 會被停止。如果發布者也在其中，註冊表保持不變，`Graft.provide`
以 `ServiceConflict` 失敗。`Pending`
fork 的必要相依是在等待啟動，不屬於重新啟動的 watcher。

直接自我相依的錯誤 `reason` 為 `"SelfDependency"`，間接環為
`"DependencyCycle"`。錯誤還帶有發布者的 `fork` ID 和服務的
`realm`。包裝環境服務時，請為輸入和輸出使用不同的鍵。若發布者的 resolution 已因相依變更而失效，也不能發布，此時
`reason` 為 `"Invalidated"`。

如果環錯誤從 `apply` 或 `Plugin.fork`
任務傳播出來，Graft 會清理發布者，發布者進入
`Failed`。隨後它等待設定、相依項目或圖發生變化，而不會依 retry
schedule 反覆撞上同一個環。重試之前，Graft 會先把失敗 fork 預期取得的相依項目放回圖中再做檢查。清理期間釋放 fork 的 lease，本身並不能解除環。

拒絕發布不會寫入服務值，也不會觸發既有 watcher 重新啟動。正常的失敗傳播仍然適用：等待子外掛失敗的外掛可能隨之失敗；失敗的 fork 之前已發布的服務被撤回時，其消費者仍會受到影響。
