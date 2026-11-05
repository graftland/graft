---
title: 外掛中的 Effect
description:
  撰寫 Graft 能夠停止並清理的外掛程式碼：取得資源、處理失敗、重試和執行工作。
---

在 `apply`
內，外掛就是一般的 Effect 程式碼；Graft 只負責包住它的 fork。只要每個資源、fiber 和失敗都留在這個 fork 內，Graft 就能停止、重試和取代外掛，而不會留下任何洩漏。

## 匯入時只描述，在 `apply` 中取得

外掛模組只定義值。任何會開啟、啟動或從外部讀取的操作都在 `apply`
中執行，由 fork 的 `Scope`
持有。在匯入時開啟的連線池永遠不會關閉，而且每次重載都會再開一個：

```ts skip
const pool = createPool(process.env.DATABASE_URL)
```

改在 `apply` 中開啟，fork 啟動時開啟、停止時關閉：

```ts
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Pool {
	readonly end: () => Promise<void>
}
declare const createPool: (url: string) => Pool

class Database extends Context.Service<Database, Pool>()("app/Database") {}

export default Plugin.make({
	name: "database",
	config: Schema.Struct({ url: Schema.String }),
	apply: ({ url }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				Effect.sync(() => createPool(url)),
				(pool) => Effect.promise(() => pool.end()),
			)
			yield* Graft.provide(Database, pool)
		}),
})
```

服務鍵、事件識別物件、schema、錯誤型別和外掛本身放在模組頂層；其餘規則請見[外掛模組的規則](../../hot-reload/#外掛模組的規則)。設定請從設定欄位讀取，不要讀
`process.env`；請參閱[設定該放在哪裡](../design/#設定該放在哪裡)。

## 釋放資源

依資源需要存活多久來選擇工具：

| 資源存活……                         | 使用                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| 與 fork 一樣久，且有關閉操作       | `Effect.acquireRelease(open, close)`                                             |
| 與 fork 一樣久，只有停止時要做的事 | `Effect.addFinalizer((exit) => ...)`                                             |
| 只為一項工作（一個請求、一個批次） | 在該工作外包一層 `Effect.scoped`，或使用 `Effect.acquireUseRelease`              |
| 只為一次處理函式呼叫               | 在處理函式中取得。請參閱[處理函式的 context](../../events/#處理函式的-context)。 |
| 只為一個背景任務                   | 在任務內取得。請參閱[背景任務](../../plugins/#背景任務)。                        |

- **在 `acquireRelease` 內開啟，不要在它之前開啟。**
  開啟步驟不會在中途被中斷，而且一旦成功，關閉步驟就已經註冊。
- **讓失敗的關閉成為 defect。**
  吞掉問題的關閉步驟會掩蓋洩漏；Graft 會把清理 defect 保留在 `Cause` 中。

## 包裝 promise 與回呼

依 rejection 代表什麼來選擇建構函式：

| 這段程式碼……                     | 使用                                | 失敗會變成           |
| -------------------------------- | ----------------------------------- | -------------------- |
| 在正常運作中就可能 reject（I/O） | `Effect.tryPromise({ try, catch })` | 你的 tagged error    |
| 只有出 bug 時才會 reject         | `Effect.promise`                    | defect               |
| 在正常運作中可能同步拋出例外     | `Effect.try({ try, catch })`        | 你的 tagged error    |
| 透過回呼回報，而不是回傳 promise | `Effect.callback`                   | 你傳給 `resume` 的值 |

```ts title="forecast.ts"
import { Effect, Schema } from "effect"

// A promise-based client library; this one is always offline.
const weatherApi = {
	today: (city: string, options: { signal: AbortSignal }): Promise<string> =>
		Promise.reject(new Error(`No route to the weather service for ${city}`)),
}

export class ForecastFailed extends Schema.TaggedError<
	ForecastFailed,
	{ readonly brand: unique symbol }
>()("ForecastFailed", { city: Schema.String, cause: Schema.Defect() }) {}

export const today = (city: string) =>
	Effect.tryPromise({
		try: (signal) => weatherApi.today(city, { signal }),
		catch: (cause) => ForecastFailed.make({ city, cause }),
	})
```

- **把 `signal` 傳下去。**
  fiber 被中斷時（例如 fork 停止），Effect 會中止它。忽略 `signal`
  的 promise 會在 fork 消失後繼續執行。
- **讓 `catch` 回傳 tagged error。** 沒有 `catch` 時，`Effect.tryPromise` 會以
  `UnknownError` 失敗，呼叫端無從得知是什麼失敗了。把原始錯誤保留在 `cause` 中。

## 預期的失敗與 defect

呼叫端能據以採取行動的失敗是**預期的失敗**：effect 錯誤型別中的一個 tagged
error。代表程式碼本身有錯的失敗則是 **defect**。

| 情況                                 | 處理成                                                          |
| ------------------------------------ | --------------------------------------------------------------- |
| 找不到、無法使用、遭到限速、輸入無效 | tagged error 類別，例如 `Schema.TaggedError`                    |
| 呼叫端應該處理的函式庫錯誤           | 你自己的 tagged error，並把函式庫錯誤放進 `cause`               |
| 不變條件被破壞、不可能走到的分支     | defect：`Effect.die`，或對沒有人能處理的錯誤使用 `Effect.orDie` |

錯誤型別是服務或事件契約的一部分：請保持精確，不要用
`unknown`。任務錯誤會併入外掛的型別；請參閱[型別中的任務錯誤](../../plugins/#型別中的任務錯誤)。

## 在能採取行動的地方復原

在能處理錯誤的地方捕捉它，其餘的讓它往上傳：

```ts import.meta.vitest name="best-practices/effect: recover where you can act"
import { Cause, Effect } from "effect"

import { today } from "./forecast.ts"

const answer = (city: string) =>
	Effect.catchTag(today(city), "ForecastFailed", (error) =>
		Effect.as(
			Effect.logWarning("Forecast lookup failed", Cause.fail(error)),
			"Weather is unavailable right now.",
		),
	)

await Effect.runPromise(answer("Oslo")) // => "Weather is unavailable right now."
```

| 失敗發生在                            | 復原方式                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| 要回應某人的呼叫（處理函式、請求）    | 以備用回應作答，如上例                                                               |
| 背景迴圈的某一輪                      | 在任務內、交給 `Plugin.fork` 之前捕捉；請參閱[任務失敗時](../../plugins/#任務失敗時) |
| 重複執行就可能成功的呼叫              | `Effect.retry`；請參閱[讓 fork 失敗並重試](#讓-fork-失敗並重試)                      |
| fork 本身的狀態（連線中斷、設定有誤） | 不捕捉：讓 fork 失敗                                                                 |

| 規則                                                     | 避免的陷阱                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 用 `Effect.catchTag` 依標籤捕捉。                        | 其他錯誤留在型別中，呼叫端看得到，不會被意外處理掉。                                                  |
| 記錄 `Cause`，而不是 `error.message`。                   | 日誌會保留錯誤的欄位、堆疊，以及一同發生的 defect。請參閱[記錄 Cause](../observability/#記錄-cause)。 |
| 不要為了讓壞掉的部分撐下去而忽略錯誤，或記錄後繼續執行。 | fork 會一直停在 `Active`，卻什麼也沒做。失敗的 fork 看得見、會被清理，也可以重試。                    |
| 不要用 `Effect.catchCause` 捕捉 defect 來繼續執行。      | defect 就是 bug；從中復原只會讓 bug 在已損壞的狀態上繼續運作。                                        |

## 讓 fork 失敗並重試

`apply`
或任務中的失敗會[讓 fork 失敗](../../plugins/#失敗與重試)。請在重試單一呼叫和重試整個 fork 之間做選擇：

|          | 包在呼叫外的 `Effect.retry` | 外掛的 `retry` 選項                             |
| -------- | --------------------------- | ----------------------------------------------- |
| 重複執行 | 一個操作                    | 整個 `apply`，資源和任務都重新建立              |
| 狀態     | 保留                        | 釋放；下一次嘗試從乾淨狀態開始                  |
| 消費者   | 不會察覺                    | 服務被撤回；消費者重新啟動，或在 `Pending` 等待 |

```ts
import { Effect, Schedule, Scope } from "effect"

import { Plugin } from "@graftland/graft"

interface Session {
	readonly next: Effect.Effect<string, Error>
}
declare const connect: Effect.Effect<Session, Error, Scope.Scope>
declare const publish: (item: string) => Effect.Effect<void>

const feed = Plugin.make({
	name: "feed",
	retry: Schedule.spaced("10 seconds"),
	apply: () =>
		Effect.gen(function* () {
			const session = yield* connect
			yield* session.next.pipe(
				Effect.retry({ times: 3, schedule: Schedule.spaced("200 millis") }),
				Effect.flatMap(publish),
				Effect.forever,
				Plugin.fork,
			)
		}),
})
```

讀取失敗時，會在同一個 `session` 上重試；`connect`
失敗，或讀取一再失敗，則會讓 fork 失敗，再依外掛的排程重新連線。

- 不要用 `retry` 等待服務；`inject` 會讓 fork 停在 `Pending`。
- 外掛排程的選法請見[重試不穩定的資源](../production/#重試不穩定的資源)。

## 背景工作與並行

每個 fiber 都需要一個擁有者來結束它，並看見它失敗；在外掛中，這個擁有者就是 fork。

| 需求                                | 使用                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| fork 執行期間持續執行的迴圈或監聽器 | `Plugin.fork`                                                                         |
| 同時執行數個步驟，並等待全部完成    | 帶 `concurrency` 的 `Effect.all` 或 `Effect.forEach`                                  |
| 一連串的值                          | `Stream`，在 `Plugin.fork` 任務中消費                                                 |
| 由呼叫端交給單一 worker 處理的工作  | 在 `apply` 中建立的 `Queue`，由 `Plugin.fork` 任務取出處理                            |
| 廣播給每個訂閱者的值                | 在 `apply` 中建立、以 `PubSub.shutdown` 關閉的 `PubSub`                               |
| fork 的任務和服務共用的狀態         | 在 `apply` 中建立的 `Ref`                                                             |
| 以 ID 為鍵、會互相取代的任務        | 在 `apply` 中建立的 `FiberMap`，並用 `Plugin.fork(FiberMap.join(map))` 讓失敗浮現出來 |

```ts
import { Context, Effect, Queue } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Mail {
	readonly to: string
	readonly text: string
}
declare const deliver: (mail: Mail) => Effect.Effect<void, Error>

class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (mail: Mail) => Effect.Effect<void> }
>()("app/Mailer") {}

const mailer = Plugin.make({
	name: "mailer",
	apply: () =>
		Effect.gen(function* () {
			const outbox = yield* Queue.bounded<Mail>(100)
			yield* Queue.take(outbox).pipe(
				Effect.flatMap(deliver),
				Effect.forever,
				Plugin.fork,
			)
			yield* Graft.provide(Mailer, {
				send: (mail) => Effect.asVoid(Queue.offer(outbox, mail)),
			})
		}),
})
```

`send`
的呼叫端只負責放入佇列。投遞在 mailer 自己的任務中執行：它隨 mailer 停止，它的失敗會讓 mailer 失敗，而不是讓呼叫端失敗。

| 避免                                                       | 原因                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Effect.forkChild`                                         | `apply` 一回傳 fiber 就會被中斷，而中斷不會讓外掛失敗，工作就這樣悄悄停止。                            |
| `Effect.forkScoped`、`Effect.forkDetach`、`Effect.runFork` | Graft 永遠看不到 fiber 失敗，而且後兩者會比 fork 活得更久。請參閱[背景任務](../../plugins/#背景任務)。 |
| 從服務方法中 fork                                          | 方法在呼叫端的 fiber 中執行。請在 `apply` 中啟動 worker，並透過 `Queue` 把工作交給它。                 |

## 計時器與時間

原生計時器會比 fork 活得更久、忽略中斷，也無法由 `TestClock`
控制（請參閱[控制時間](../testing/#控制時間)）。請改用 Effect 的對應寫法：

| 不要用                        | 改用                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `setTimeout(work, ms)`        | `Plugin.fork(Effect.delay(work, ms))`，或在任務內使用 `Effect.sleep` |
| `setInterval(work, ms)`       | `Plugin.fork(Effect.repeat(work, schedule))`，或 `Stream.tick`       |
| 暫停，或固定速率              | `Schedule.spaced` 在每次執行後等待；`Schedule.fixed` 維持固定速率    |
| 與計時器賽跑的 promise        | `Effect.timeout`                                                     |
| `Date.now()`、`Math.random()` | `Clock.currentTimeMillis`、`Random.next`                             |

## 在邊界驗證

外部資料在進入時解碼一次，內部只傳遞有型別的值：

| 輸入                 | 解碼方式                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| 外掛設定             | `config` schema；請參閱[設定解碼](../../plugins/#設定解碼)                    |
| 請求本文、訊息、檔案 | `Schema.decodeUnknownEffect(schema)`；在回應傳送方的地方捕捉 `SchemaError`    |
| JSON 文字            | 用 `Schema.fromJsonString(schema)` 取代 `JSON.parse`                          |
| 機密                 | `Schema.RedactedFromValue`；請參閱[型別與機密](../../config-file/#型別與機密) |

在內部保持值不可變：用 `Option` 取代 `null`、使用依值比較的 `Data` 類別、把
`HashMap` 放進 `Ref` 而不是使用可變的 `Map`，陣列和欄位都標為 `readonly`。

## 把相依寫進型別

需求屬於 effect 的型別，由編譯器負責檢查：

| 需要                 | 滿足方式                                                           |
| -------------------- | ------------------------------------------------------------------ |
| 另一個外掛發布的服務 | `inject`；請參閱[相依](../../plugins/#相依)                        |
| 與宿主同壽的服務     | 環境 Layer；請參閱[來自環境的服務](../../services/#來自環境的服務) |
| 隨呼叫端變化的設定   | `Context.Reference` 搭配 [intercept](../../intercepts/)            |

- **服務方法中不留需求。** 在 `apply` 中讀取相依並由閉包捕獲，就像 `mailer`
  捕獲它的佇列；留在方法型別中的需求，每個呼叫端都必須滿足。只有要[隨呼叫端變化](../../intercepts/#隨呼叫端變化的設定)的
  `Context.Reference` 設定才在方法中讀取。
- **不用模組層級的單例、`any` 或型別斷言。** 它們會隱藏原本由編譯器檢查的需求。
