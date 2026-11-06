---
title: 日誌與追蹤
description: 從外掛寫出有用的日誌，並匯出 Graft 的 span。
---

外掛使用 Effect 本身的工具記錄日誌和追蹤：`Effect.log*`、日誌註解和 span。Graft 會替每個外掛記錄的日誌行加上註解，並把每次外掛啟動包在一個 span 中；兩者要送往何處，由宿主決定。

## 選擇日誌層級

訊息保持固定，會變動的值放進註解，結構化輸出才方便搜尋和過濾：

```ts import.meta.vitest name="observability: annotate a log line"
import { Effect, Option, Stream } from "effect"

import { Graft } from "@graftland/graft"

interface Order {
	readonly id: string
}

const accepted = (order: Order) =>
	Effect.log("Order accepted").pipe(
		Effect.annotateLogs({ "shop.order": order.id }),
	)

const annotations = await Effect.runPromise(
	Effect.gen(function* () {
		yield* accepted({ id: "A-17" })
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.annotations)
	}).pipe(Effect.provide(Graft.layer)),
)
annotations // => Option.some({ "shop.order": "A-17" })
```

| 層級    | 用途                                                  | 訊息範例                                 |
| ------- | ----------------------------------------------------- | ---------------------------------------- |
| `Error` | 已經處理、但需要有人查看的失敗。                      | `Payment refused; order dropped`         |
| `Warn`  | 功能降級但仍在運作：改用後備、重試、丟棄一筆資料。    | `Sync failed; serving the last snapshot` |
| `Info`  | 維運人員預設想看到的內容：開始監聽、已連線、已就緒。  | `Listening on 8080`                      |
| `Debug` | 診斷單一外掛用的細節：每個請求、每則訊息。            | `Received frame`                         |
| `Trace` | 連除錯時都嫌太多的細節，例如 payload 內容。           | `Frame bytes`                            |
| `Fatal` | 不適用於外掛。外掛的失敗屬於它的 fork，讓它失敗就好。 |                                          |

除非宿主或項目另行修改，最低層級為
`Info`。低於這個層級的日誌行不會送到任何 logger，`Graft.logs` 也收不到。

## 記錄 Cause

把 `Cause` 當作引數傳入，而不是
`error.message`。logger 會保留整個錯誤和它的堆疊追蹤；訊息只留下一個字串。依 tag 捕捉到的錯誤，用
`Cause.fail` 包起來：

```ts import.meta.vitest name="observability: log the cause"
import { Cause, Effect, Option, Schema, Stream } from "effect"

import { Graft } from "@graftland/graft"

class SyncFailed extends Schema.TaggedError<
	SyncFailed,
	{ readonly brand: unique symbol }
>()("SyncFailed", {}) {}

const sync = Effect.fail(SyncFailed.make())

const synced = Effect.catchTag(sync, "SyncFailed", (error) =>
	Effect.logWarning(
		"Sync failed; serving the last snapshot",
		Cause.fail(error),
	),
)

const cause = await Effect.runPromise(
	Effect.gen(function* () {
		yield* synced
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.cause)
	}).pipe(Effect.provide(Graft.layer)),
)
cause // => Option.some(Cause.fail(SyncFailed.make()))
```

| 情況                                            | 做法                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| 你復原並繼續執行。                              | 在復原的地方以 `Warn` 或 `Error` 記錄 cause。                                           |
| 失敗傳到 `apply` 或 `Plugin.fork` 任務。        | 不要記錄。Graft 會記錄完整的 cause，並保留在 `Failed` 狀態中。                          |
| 你刻意放棄盡力而為的工作。                      | `Effect.ignore({ log: "Warn", message: "Refreshing the cache failed" })` 會記錄後繼續。 |
| 你用 `Effect.tapCause` 記錄，並讓失敗繼續傳遞。 | 同一個失敗會被記錄兩次。兩者擇一。                                                      |

是否該復原，請參閱[外掛中的 Effect](../effect/)。

### Graft 記錄的內容

可以搜尋這些訊息，或針對它們設定警示。純中斷是正常的取消，不會寫出其中任何一則。

| 訊息                                                                          | 層級    | 時機                                                                                                  |
| ----------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `Plugin "<name>" failed`                                                      | `Error` | `apply` 失敗。每次重試失敗都會再記錄一次。                                                            |
| `The plugin's background task failed`                                         | `Error` | [`Plugin.fork` 任務](../../plugins/#任務失敗時)失敗。                                                 |
| `Releasing the plugin's resources failed`                                     | `Error` | fork 停止時，有 finalizer 失敗。                                                                      |
| `Updating in place failed; restarting instead`                                | `Warn`  | 外掛的[原地更新](../../plugins/#原地更新)失敗，fork 改為重新啟動。                                    |
| `The plugin's retry schedule failed`                                          | `Error` | `retry` 排程本身失敗。                                                                                |
| `Still waiting for consumers of <keys>; a teardown cycle may be holding them` | `Warn`  | 撤回服務時仍在等待其消費者停止。請參閱[停不下來的停止](../troubleshooting/#停不下來的停止)。          |
| `Disposing a loader entry failed`                                             | `Error` | [清理已移除或已取代的項目](../../config-file/#清理失敗)失敗。帶有 `loader.entry` 和 `loader.plugin`。 |

## 註解

`graft.fork` 是 fork 的 `id`，與 fork 樹中的數字相同。`graft.plugin` 是外掛的
`name`。一行日誌標示的是哪個 fork，取決於執行該程式碼的 fiber：

| 程式碼                                      | 帶有的註解                                       |
| ------------------------------------------- | ------------------------------------------------ |
| `apply`、它的 finalizer、`Plugin.fork` 任務 | 外掛自己的 fork。                                |
| 事件處理函式                                | 註冊該處理函式的 fork。                          |
| 服務方法                                    | **呼叫**它的 fork。方法在呼叫端的 fiber 中執行。 |
| 任何外掛之外的宿主程式碼                    | 沒有。請參閱[日誌](../../lifecycle/#日誌)。      |

自己的註解，加在對每一行都成立的最小範圍上：

| 對象                        | 使用                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| 單一 effect，或整個 `apply` | 接在後面的 `Effect.annotateLogs({ ... })`。                                                        |
| 一個 fork 及其下的所有外掛  | 以 [`Graft.intercept`](../../intercepts/#修改-reference) 修改 `References.CurrentLogAnnotations`。 |
| `graft.yml` 中的一個項目    | [`effect/References/CurrentLogAnnotations`](../../config-file/#設定檔中的-intercept)。             |

- 鍵以你的套件名稱為前綴，就像 Graft 使用 `graft.`、`loader.` 和 `remote.`。
- 要區分服務自己的日誌行和呼叫端的日誌行，請在方法內加上註解。
- 機密在真正需要它的呼叫之前都保持 `Redacted`。`Redacted` 值記錄為
  `<redacted>`；一般字串則原樣記錄。請參閱[型別與機密](../../config-file/#型別與機密)。

## 依設定項目設定層級

只降低你正在診斷的那個設定項目的層級。這項設定涵蓋該項目及其子外掛；同層項目保留各自的設定。

| 目標                      | 設定                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| 查看單一外掛的 debug 日誌 | 在項目的 `intercept` 中設定 `effect/References/MinimumLogLevel: Debug`。 |
| 讓話太多的外掛安靜下來    | 在項目的 `intercept` 中設定 `effect/References/MinimumLogLevel: Warn`。  |
| 從 TypeScript 做同樣的事  | 在 `Graft.plugin` 的 `intercept` 選項中使用 `Graft.intercept`。          |

- 修改 `intercept`
  會卸載並重新載入該項目。請參閱[執行期間的變更](../../config-file/#執行期間的變更)。
- `graft start` 沒有設定全域層級的選項，請在設定項目上設定。
- 嵌入 Graft 的宿主必須先[登記這些鍵](../../intercepts/#設定檔-intercept)，才能在 YAML 中使用它們，做法如[以嵌入取代 CLI](../production/#以嵌入取代-cli)所示。

## 在宿主中選擇輸出

`graft start`
把[易讀的日誌行](../../cli/#日誌與-intercept)輸出到標準錯誤，沒有其他格式可選。若要輸出 JSON 行或交給日誌收集器，請[嵌入 Graft](../../embedding/)，並在
`Graft.layer` 下方提供 `Logger`
layer；沒有提供時，由 Effect 的預設 logger 輸出。

```ts import.meta.vitest name="observability: choose the output"
import { Effect, Layer, Logger, Option, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

const runtime = Layer.provideMerge(
	Graft.layer,
	Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.consoleJson])),
)

const message = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Effect.log("Listening on 8080")
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.provide(runtime)),
)
message // => Option.some(["Listening on 8080"])
```

`Graft.layer`
會把自己的收集器加到它在那裡找到的 logger 之中。在更靠近程式的地方提供的
`Logger.layer`，或在 `Layer.mergeAll` 中列在 `Graft.layer` 之後的
`Logger.layer`，會取代這個收集器，`Graft.logs` 就什麼都收不到。

[遠端外掛](../../remote/overview/)的日誌以它們自己的層級送到宿主的 logger，外掛的註解放在
`remote.annotations` 中，並帶有 `remote.pid` 或
`remote.threadId`。高負載下遺失的日誌會顯示為
[`Remote logs were dropped`](../../remote/transport-auth/#警告)。

## 在外掛中收集日誌

`Graft.logs`
串流環境中記錄的每一筆日誌，可用於警示、日誌檢視或測試。基本行為請參閱[日誌](../../lifecycle/#日誌)。

```ts import.meta.vitest name="observability: collect logs in a plugin"
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	LogLevel,
	Stream,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Pager extends Context.Service<
	Pager,
	{ readonly page: (entry: Graft.LogEntry) => Effect.Effect<void> }
>()("app/Pager") {}

const alerts = Plugin.make({
	name: "app/alerts",
	inject: [Pager],
	apply: () =>
		Effect.gen(function* () {
			const pager = yield* Pager
			const started = yield* Clock.currentTimeMillis
			yield* Graft.logs.pipe(
				Stream.filter(
					(entry) =>
						entry.date.getTime() >= started &&
						LogLevel.isGreaterThanOrEqualTo(entry.level, "Error"),
				),
				Stream.runForEach(pager.page),
				Plugin.fork,
			)
		}),
})

const pages = Deferred.makeUnsafe<Graft.LogEntry>()
const layer = Layer.provideMerge(
	Graft.layer,
	Layer.succeed(Pager, { page: (entry) => Deferred.succeed(pages, entry) }),
)

const paged = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(alerts)
		yield* fork.await
		yield* Effect.log("Order accepted")
		yield* Effect.logError("Payment refused; order dropped")
		const entry = yield* Deferred.await(pages)
		return entry.message
	}).pipe(Effect.scoped, Effect.provide(layer)),
)
paged // => ["Payment refused; order dropped"]
```

| 陷阱       | 規則                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 重播的日誌 | 新的訂閱者會先收到[最近的日誌](../../lifecycle/#日誌)，所以重新啟動的外掛會再看到一次。請依 `date` 過濾。 |
| 回饋迴圈   | 你的外掛自己寫的日誌行也會送進來。不要以你轉送的層級記錄日誌，或略過帶有你自己 `graft.plugin` 的日誌。    |
| 消費太慢   | 緩衝區會滑動。落後的訂閱者會遺失最舊的日誌；記錄日誌永遠不會等它。                                        |

## Span

Graft 在名為 `graft.plugin <name>` 的 span 中解碼外掛的設定並執行
`apply`。每次載入、重新啟動和重試都會開始一個新的 span。你自己的操作，用
`Effect.fn` 或 `Effect.withSpan` 命名：

```ts import.meta.vitest name="observability: name your spans"
import { Effect, Option, Schema, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// Stands in for a real connection.
const connect = (url: string) => Effect.logDebug(`Connecting to ${url}`)

const feed = Plugin.make({
	name: "app/feed",
	config: Schema.Struct({ url: Schema.String }),
	apply: Effect.fn("feed.apply")(function* ({ url }) {
		yield* connect(url).pipe(
			Effect.withSpan("feed.connect", { attributes: { url } }),
		)
	}),
})

// Records each span as "parent > name".
const spans: Array<string> = []
const tracer = Tracer.make({
	span: (options) => {
		const parent = Option.getOrUndefined(options.parent)
		spans.push(
			parent?._tag === "Span"
				? `${parent.name} > ${options.name}`
				: options.name,
		)
		return new Tracer.NativeSpan(options)
	},
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(feed, { url: "https://example.com/feed" })
		yield* fork.await
	}).pipe(
		Effect.scoped,
		Effect.withTracer(tracer),
		Effect.provide(Graft.layer),
	),
)
spans // => ["graft.plugin app/feed", "graft.plugin app/feed > feed.apply", "feed.apply > feed.connect"]
```

- `graft.plugin <name>` 位於載入該外掛時所在的 span 之下，因此在 `apply`
  中載入的子外掛，會位於父外掛的 span 之下。
- `apply` 內以及它的 `Plugin.fork` 任務內的 span，都位於 `graft.plugin <name>`
  之下，即使該 span 在 `apply` 回傳時就已結束。
- span 以外掛和操作命名，如範例中的 `Effect.fn("exchange.apply")`。
- 印出的 cause 會把 span 顯示為一個 frame：`at graft.plugin <name>`。

每個 `graft.plugin <name>` span 都帶有該外掛日誌的身分 `graft.fork` 和
`graft.plugin`，另外還有 `graft.revision`：

| 屬性             | 值                                                         |
| ---------------- | ---------------------------------------------------------- |
| `graft.fork`     | fork 的 `id`。                                             |
| `graft.plugin`   | 外掛的 `name`。                                            |
| `graft.revision` | 從 0 開始，`restart`、取代和回滾時遞增；設定更新不改變它。 |

### 匯出 span

`graft start` 會建立 span，但不安裝任何 exporter。用
[`@graftland/plugin-otlp`](https://github.com/graftland/graft/tree/main/packages/plugin-otlp)
外掛匯出它們：這是一個只用公開 Graft API 建構的普通外掛。它自己載入 `plugins`
中的項目，並把這棵子樹的 span 送到 OTLP/HTTP 收集器：

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    url: !env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    serviceName: chat-bot
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| 修改                       | 效果                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP exporter 設定         | 新 span 交給新的 exporter；已開始的 span 留在舊 exporter；這些 span 結束後刷新並關閉舊 exporter。等待最長為舊設定的 `shutdownTimeout`；Effect 隨後為刷新單獨提供一個 `shutdownTimeout` 時限（總計最長為兩倍時限）。子樹繼續執行。 |
| `exporter.config`          | 轉交給 exporter 的更新函式；相容的更新保持子樹執行。                                                                                                                                                                              |
| `plugins`                  | 像群組一樣協調：未變更的項目繼續執行。exporter 設定未變時，不呼叫其更新函式。                                                                                                                                                     |
| `exporter.name`            | 使用新的 provider 重新啟動被追蹤的子樹。                                                                                                                                                                                          |
| 將項目移入或移出 `plugins` | 這些項目會重新啟動，因為父層和 intercept 改變了。                                                                                                                                                                                 |
| Exporter 失敗              | 子樹等待 `Exporter` 服務；exporter 自身重試成功後，子樹恢復執行，無需修改設定。                                                                                                                                                   |
| 卸載該項目                 | 先停止子樹，再並行刷新並關閉所有剩餘 exporter。                                                                                                                                                                                   |

`plugins` 之外的外掛不會被追蹤。Graft 會像處理最外層項目一樣，把 `plugins`
中缺少的 id 寫回檔案，調整順序時保留身分。

HTTP 欄位是一般外掛 `@graftland/plugin-otlp/http` 的簡寫。它支援
`serialization: json | protobuf`、資源屬性和批次匯出選項；預設值見
[套件設定](https://github.com/graftland/graft/tree/main/packages/plugin-otlp#readme)。時間以毫秒計；數值欄位接受
`!env` 字串。HTTP 標頭以 `Redacted` 儲存，憑證透過 `headers` 中的 `!env`
傳入。缺少 `HttpClient` 時，HTTP 外掛停在 `Pending`。

使用 `exporter` 取代 HTTP 欄位，選擇第三方實作：

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    exporter:
      name: graft-plugin-custom-traces
      config:
        destination: !env TRACE_DESTINATION
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| Exporter 契約 | 規則                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服務          | 透過 `Graft.provide` 發布 `@graftland/plugin-otlp/Exporter` 中的穩定 `Tracer.Tracer` 服務 `Exporter`，key 為 `@graftland/plugin-otlp/Exporter`。 |
| 生命週期      | 資源和 fiber 由外掛 scope 管理；更新時保留未完成的 span，關閉時清空，保留失敗的 cause。                                                          |
| 更新          | 回傳更新函式並保持已發布的 tracer 物件不變。重新啟動會撤回服務並重新啟動使用者。                                                                 |
| 隔離          | 每個宿主隔離 `Exporter`；實作仍可注入應用服務。簡寫和明確名稱都透過 `ModuleResolver` 解析。                                                      |
| 驗證          | 為 `Testing.exporter` 提供新的 `Graft.layer` 和收集器；`received` 在關閉後回傳已匯出的 span 名稱。                                               |

```ts
import { Effect } from "effect"

import type { Plugin } from "@graftland/graft"
import * as Testing from "@graftland/plugin-otlp/Testing"

declare const exporter: Plugin.Plugin
declare const received: Effect.Effect<ReadonlyArray<string>>

const conformance = Testing.exporter({
	plugin: exporter,
	config: { destination: "test" },
	nextConfig: { destination: "updated" },
	received,
})
```

Effect 每棵子樹只有一個 tracer，沒有 fan-out 組合器；巢狀宿主會覆蓋外層 tracer。其他傳輸、屬性擴充和廠商 exporter 由第三方實作。本套件不提供日誌和指標匯出；第三方可以實作這些功能。

嵌入 Graft 時，也可以在放 [`Logger` layer](#在宿主中選擇輸出) 的位置提供 tracer
layer，例如 `effect/observability` 中的 OTLP exporter：

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

const tracing = OtlpTracer.layer({
	url: "http://localhost:4318/v1/traces",
	resource: { serviceName: "chat-bot" },
}).pipe(
	Layer.provide(
		Layer.mergeAll(OtlpSerialization.layerJson, FetchHttpClient.layer),
	),
)
```

- 每個外掛都從載入它的地方繼承 tracer，包括 loader 載入的項目。
- Effect 的預設 logger 會把日誌行作為事件附加到目前的 span。`Logger.layer`
  會取代這些預設 logger；要保留這項行為，請在其中列出 `Logger.tracerLogger`。
- 遠端外掛在另一個行程或 worker 中執行，宿主的 tracer 到不了那裡。

## 用 fork 樹診斷

日誌記錄發生過的事；[`Graft.forks`](../../lifecycle/#fork-樹) 顯示現在的狀況。在
`Pending`
中等待的 fork 不會寫出任何日誌行，所以請把一直停在那裡的 fork 記錄下來：

```ts import.meta.vitest name="observability: log the forks that wait"
import { Array, Context, Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

const waiting = Plugin.make({
	name: "app/waiting",
	apply: () =>
		Graft.forks.pipe(
			Stream.debounce("5 seconds"),
			Stream.map(unhealthy),
			Stream.runForEach((forks) =>
				forks.length === 0
					? Effect.void
					: Effect.logWarning("Forks not running", forks),
			),
			Plugin.fork,
			Effect.asVoid,
		),
})

class Database extends Context.Service<Database, {}>()("app/Database") {}

const reports = Plugin.make({
	name: "app/reports",
	inject: [Database],
	apply: () => Effect.void,
})

const warning = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(waiting)
		yield* Graft.plugin(reports)
		const entry = yield* Stream.runHead(
			Stream.filter(Graft.logs, (entry) => entry.level === "Warn"),
		)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
warning // => Option.some(["Forks not running", ["app/reports: Pending"]])
```

- `unhealthy`
  是[回報健康狀態](../production/#回報健康狀態)中的走訪函式，它會列出處於
  `Pending` 或 `Failed` 的 fork。
- 請替串流加上 debounce：它在每次變化時都會送出，項目載入期間會送出很多次。
- `Failed` 節點的 `cause` 包含 Graft 為它記錄過的失敗。
- 症狀及其原因，請參閱[疑難排解](../troubleshooting/)。
