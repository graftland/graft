---
title: 外掛
description: 使用 Plugin.make、Plugin.service 和 Plugin.layer 定義外掛。
---

外掛是一個描述如何啟動某項功能的值。載入外掛會建立一個
**fork**。fork 是一個執行實例，擁有獨立的設定和
`Scope`。同一個外掛載入兩次，會得到兩個獨立的 fork。

## 定義外掛

```ts
import { Plugin } from "@graftland/graft"
import { Effect, Schedule, Schema } from "effect"

export const ticker = Plugin.make({
	name: "ticker",
	config: Schema.Struct({ every: Schema.Duration }),
	apply: ({ every }) =>
		Effect.log("tick").pipe(
			Effect.repeat({ schedule: Schedule.spaced(every) }),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

| 選項     | 作用                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `name`   | 用於日誌和 fork 樹的名稱。                                             |
| `config` | Effect `Schema`，用於在執行 `apply` 前解碼輸入。不需要設定時可以省略。 |
| `inject` | 外掛需要的服務。請參閱[相依](#相依)。                                  |
| `apply`  | 啟動外掛，在 fork 的 `Scope` 內執行。                                  |
| `retry`  | 在 `apply` 或受監督任務失敗後重新啟動外掛的 `Schedule`。               |

`apply` 在外掛載入期間保持開啟的 `Scope` 中執行。用 `Effect.acquireRelease`
管理資源、用 `Plugin.fork` 啟動背景任務、用 `Graft.plugin` 載入子外掛、用
`Event.on` 註冊事件處理函式。

`Plugin.fork(effect)` 回傳任務的 fiber。activation 的 `FiberSet`
持有這個 fiber，即使呼叫端用 `Effect.asVoid`
丟棄控制代碼，也不會失去監督。`apply`
結束表示啟動完成，任務可以繼續執行。任務繼承啟動處的 context，因此可以使用
`inject` 宣告的相依項目。每個任務都有自己的
`Scope`。任務取得的資源會在任務結束或被取消時釋放，即使任務是從存活時間更短的 scope 中啟動的。

任務未處理的錯誤或 defect 會使整個 activation 失敗。即使 `apply`
尚未結束，或正在原地更新，也是如此。Graft 先停止
`apply`，關閉發布並撤回服務，再排空消費者，期間仍健康的任務繼續服務這些消費者。排空之後，Graft 才停止剩餘任務、等待其清理完成，並關閉 activation 的資源。Graft 會保留任務失敗及取消 defect 的完整 Cause，並記錄日誌。任務僅被中斷不會使外掛失敗。外掛通常的
`retry`
排程仍然適用，每次重試都會建立新的任務群組。有時更新或卸載會先於失敗被處理，此時 Graft 清理舊 activation 時仍會記錄該失敗。

任務的錯誤會納入外掛的錯誤型別和
`fork.await`，包括在更新回呼、service、layer 或其他任務中啟動的任務。`Plugin.Tasks<E>`
將這個限制傳到外掛定義處。有型別標註的輔助函式必須保留它。可復原的錯誤應在任務**內部**處理，也就是在把任務傳給
`Plugin.fork`
之前。捕捉啟動操作的錯誤，不會撤銷監督；join 回傳的 fiber 後捕捉其錯誤，同樣不會撤銷監督。

裸 `Effect.forkScoped`
管理 fiber 的生命週期，但不會把 fiber 的失敗交給 Graft。外掛任務應使用
`Plugin.fork`。如果刻意使用裸 fiber，需要自行觀察其完整的 `Exit` 或 `Cause`。

### 設定解碼

設定 schema 可以做 schema 能做的任何事，包括非同步解碼和需要服務的解碼。解碼需要的服務和其他相依項目一樣，必須列入
`inject`，編譯器會檢查這一點。解碼失敗時，fork 會以 `SchemaError` 失敗。

## 相依

`inject`
列出外掛需要的服務。只有這些服務全部可用時，外掛才會啟動。任何一個服務釋放之前，外掛都會先停止。

```ts
const report = Plugin.make({
	name: "report",
	inject: [Database, Plugin.optional(Cache)],
	apply: () =>
		Effect.gen(function* () {
			const database = yield* Database
			const cache = yield* Effect.serviceOption(Cache)
			// ...
		}),
})
```

- **必要相依**（如 `Database`）可以透過 `yield*` 讀取。讀取未在 `inject`
  中宣告的服務會觸發型別錯誤，因此不會漏掉相依宣告。
- **可選相依** `Plugin.optional(Cache)` 不會阻止外掛啟動，使用
  `Effect.serviceOption`
  讀取。服務出現或消失時，外掛都會重新啟動，確保讀取到目前的狀態。

缺少必要服務時，fork 處於 `Pending` 狀態。請參閱[生命週期](../lifecycle/)。

## 原地更新

預設情況下，新設定會使外掛重新啟動：Graft 關閉舊的 `Scope`，再執行一次
`apply`。如果希望外掛繼續執行，`apply`
可以回傳一個更新函式。該函式接收 supervisor 選中的設定。如果已套用變更，回傳
`true`；如果需要重新啟動，回傳 `false`。

更新只保留最新請求的設定，不會排隊逐項交付。並行請求可能完全跳過中間設定。被後續請求取代的
`fork.update` 也會成功回傳，即使它的輸入從未傳給更新回呼、最新設定也尚未套用。

```ts
const server = Plugin.make({
	name: "server",
	config: Schema.Struct({ port: Schema.Int, banner: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			const banner = yield* Ref.make(config.banner)
			yield* startServer(config.port, banner)
			return (next) =>
				next.port === config.port
					? Effect.as(Ref.set(banner, next.banner), true)
					: Effect.succeed(false)
		}),
})
```

更新函式是一個閉包，可以使用 `apply` 建立的任何值，例如這裡的 `banner`。

解碼和執行更新組成一個可取消的操作。後續設定或相依項目變更會取消它，並等待其清理完成後再進行 activation 清理。一般更新失敗會先記錄完整 Cause，再重新啟動；卸載期間收集到的失敗也會進入
`CleanupError.cause`。更新中取得的資源仍屬於 activation Scope。

## 失敗與重試

如果 `apply` 或受監督任務失敗，fork 會進入 `Failed` 狀態並保留完整的
`Cause`。Graft 會釋放外掛取得的所有資源，並把失敗記錄到日誌中。隨後，fork 會等待下一次嘗試：設定變更、相依項目變更或
`retry` 排程觸發時，都會重試：

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## 從服務和 Layer 建立外掛

對於只發布服務的外掛，可以使用以下兩種簡寫方式。

`Plugin.service` 建立並發布一個服務：

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` 建構一個 Effect `Layer`，並發布 `provides`
中列出的服務。Graft 為每個 fork 獨立建構這個 Layer，並在 fork 停止時銷毀它：

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## 外掛模組

載入器和 CLI 從模組中匯入外掛。模組透過預設匯出或名為 `plugin`
的匯出提供外掛，`Plugin.fromModule` 也按相同的方式讀取。

匯入外掛模組時，除了定義外掛，不應執行其他操作。Graft 只能釋放 `apply`
取得的資源。另外，[熱重載](../hot-reload/)會在每次變更時重新匯入模組。
