---
title: 外掛
description: 使用 Plugin.make、Plugin.service 和 Plugin.layer 定義外掛。
---

外掛是一個描述如何啟動某項功能的值。載入外掛會建立一個
**fork**：一個執行實例，擁有獨立的設定和自己的
`Scope`。同一個外掛載入兩次，會得到兩個獨立的 fork。

| 術語       | 含義                                             |
| ---------- | ------------------------------------------------ |
| **Plugin** | 定義本身。它是一個值；載入之前不會執行任何東西。 |
| **Fork**   | 外掛的一個執行實例。                             |
| **Scope**  | 持有 fork 的資源。關閉它就會釋放這些資源。       |

## 定義外掛

```ts
import { Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

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

### 選項

| 選項     | 作用                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `name`   | 用於日誌和 fork 樹的名稱。                                             |
| `config` | Effect `Schema`，用於在執行 `apply` 前解碼輸入。不需要設定時可以省略。 |
| `inject` | 外掛需要的服務。請參閱[相依](#相依)。                                  |
| `apply`  | 啟動外掛，在 fork 的 `Scope` 內執行。                                  |
| `retry`  | 在 `apply` 或受監督任務失敗後重新啟動外掛的 `Schedule`。               |

### 在 `apply` 內該用什麼

`apply` 在外掛載入期間保持開啟的 `Scope` 中執行。請把每種工作交給負責它的工具：

| 你需要         | 使用                    |
| -------------- | ----------------------- |
| 需要清理的資源 | `Effect.acquireRelease` |
| 背景工作       | `Plugin.fork`           |
| 子外掛         | `Graft.plugin`          |
| 事件處理函式   | `Event.on`              |

### 背景任務

`Plugin.fork(effect)` 啟動一個受監督的任務，並回傳它的 fiber。

- **歸屬。** activation 的 `FiberSet` 持有這個 fiber，即使呼叫端用
  `Effect.asVoid` 丟棄控制代碼也一樣。
- **啟動。** `apply` 結束表示啟動完成，任務可以繼續執行。
- **Context。** 任務繼承啟動處的 context，因此可以使用 `inject` 宣告的相依項目。
- **資源。** 每個任務都有自己的
  `Scope`。任務取得的資源會在任務結束或被取消時釋放，即使任務是從存活時間更短的 scope 中啟動的。

### 任務失敗時

任務未處理的錯誤或 defect 會使整個 activation 失敗，即使 `apply`
仍在載入，或正在原地更新。Graft 依下列順序清理：

1. 停止 `apply`，關閉發布並撤回服務。
2. 排空消費者。期間仍健康的任務繼續服務它們。
3. 停止剩餘任務，並等待它們清理完成。
4. 關閉 activation 的資源。

失敗細節：

- **保留 Cause。** Graft 會記錄任務失敗及取消 defect 的完整 Cause。
- **中斷不是失敗。** 任務僅被中斷，不會使外掛失敗。
- **重試從乾淨狀態開始。** 外掛的 `retry`
  排程仍然適用，每次嘗試都會建立新的任務群組。
- **快速清理。**
  如果更新或卸載先於失敗被處理，Graft 清理舊 activation 時仍會記錄該失敗。

### 型別中的任務錯誤

任務的錯誤會納入外掛的錯誤型別和
`fork.await`，包括在更新回呼、service、layer 或其他任務中啟動的任務。`Plugin.Tasks<E>`
會把這個限制一路傳到外掛定義處，因此有型別標註的輔助函式必須保留它。

:::caution

想從錯誤中復原，必須在任務**內部**捕捉，也就是在把任務傳給 `Plugin.fork`
之前。下列兩種做法都無法撤銷監督：

- 捕捉啟動操作的錯誤。
- join 回傳的 fiber 後捕捉其錯誤。

:::

裸 `Effect.forkScoped`
管理 fiber 的生命週期，但不會把 fiber 的失敗交給 Graft。外掛任務應使用
`Plugin.fork`。如果使用裸 fiber，需要自行觀察其完整的 `Exit` 或 `Cause`。

### 設定解碼

設定 schema 可以做 schema 能做的任何事，包括非同步解碼和需要服務的解碼。

- 解碼需要的服務和其他相依項目一樣，必須列入 `inject`，編譯器會檢查這一點。
- 解碼失敗時，fork 會以 `SchemaError` 失敗。

## 相依

`inject`
列出外掛需要的服務。只有這些服務全部存在時，外掛才會啟動；任何一個服務消失之前，外掛都會先停止。

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

| 種類     | 宣告方式                 | 讀取方式               | 服務缺少時                             |
| -------- | ------------------------ | ---------------------- | -------------------------------------- |
| **必要** | `Database`               | `yield* Database`      | fork 在 `Pending` 狀態等待。           |
| **可選** | `Plugin.optional(Cache)` | `Effect.serviceOption` | 外掛照常啟動，並在服務變化時重新啟動。 |

- 讀取未在 `inject` 中宣告的服務會觸發型別錯誤，因此不會漏掉相依宣告。
- 可選相依會在服務出現或消失時重新啟動外掛，確保外掛讀取到目前的狀態。

缺少必要服務時，fork 處於 `Pending` 狀態。請參閱[生命週期](../lifecycle/)。

## 原地更新

預設情況下，新設定會使外掛重新啟動：Graft 關閉舊的 `Scope`，再執行一次
`apply`。如果希望外掛繼續執行，`apply` 可以回傳一個更新函式。

| 更新函式……                 | 含義               |
| -------------------------- | ------------------ |
| 接收 supervisor 選中的設定 | —                  |
| 回傳 `true`                | 已套用變更。       |
| 回傳 `false`               | 改為重新啟動外掛。 |

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

透過 [Remote](../remote/overview/)
執行的外掛不會原地更新：新設定會重新啟動它的外掛行程。

:::note

更新只保留最新請求的設定，不會排隊逐項交付。並行請求可能完全跳過中間設定。被取代的
`fork.update` 也會成功，即使它的輸入從未傳給回呼。

:::

解碼和執行更新組成一個可取消的操作：

- 後續設定或相依項目變更會取消它，並等待其清理完成後再進行清理。
- 一般更新失敗會先記錄完整 Cause，再重新啟動。卸載期間收集到的失敗也會進入
  `CleanupError.cause`。
- 更新中取得的資源仍屬於 activation Scope。

## 失敗與重試

如果 `apply` 或受監督任務失敗，fork 會進入 `Failed` 狀態並保留完整的
`Cause`。Graft 會釋放外掛取得的所有資源，並把失敗記錄到日誌中。隨後 fork 會等待，並在下列任一情況發生時重試：

- 它的設定變更。
- 它的某個相依項目變更。
- 它的 `retry` 排程觸發。

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## 從服務和 Layer 建立外掛

對於只發布服務的外掛，可以使用以下兩種簡寫方式。

| 簡寫             | 建構                | 發布                      |
| ---------------- | ------------------- | ------------------------- |
| `Plugin.service` | 一個服務            | 該服務。                  |
| `Plugin.layer`   | 一個 Effect `Layer` | `provides` 中列出的服務。 |

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` 為每個 fork 從頭建構 Layer，並在 fork 停止時銷毀它：

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## 外掛模組

載入器和 CLI 從模組中匯入外掛。

- **匯出。** 模組透過預設匯出或名為 `plugin` 的匯出提供外掛，`Plugin.fromModule`
  也按相同的方式讀取。
- **無副作用。** 匯入外掛模組時，除了定義外掛，不應執行其他操作。Graft 只能釋放
  `apply` 取得的資源。
- **重載。** 自動[熱重載](../hot-reload/)會重新匯入受變更影響的模組；公開的
  `hmr.reload` 則強制完整重載。
