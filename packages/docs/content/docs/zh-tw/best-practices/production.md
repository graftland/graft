---
title: 在正式環境執行
description: 啟動、保護、監督、重新設定、停止並升級長時間執行的 Graft 應用程式。
---

正式環境中的 Graft 應用程式是一個長時間執行的行程：`graft start`，或你自己以
`Graft.layer` 建構的程式。它由服務管理器執行，服務管理器負責重新啟動它，並以
`SIGTERM` 停止它。

## 不帶 `--watch` 啟動

建置模組後執行 `graft start graft.yml`。不支援
`--watch`。設定、環境檔案和已安裝套件在此次啟動時讀取；修改後重新建置並重新啟動。

## 傳遞機密

用 `!env` 讀取機密，並解碼為
`Redacted`，這樣檔案和日誌都不會含有它的值（[型別與機密](../../config-file/#型別與機密)）。以檔案形式掛載的機密再加上
[`--env-dir`](../../cli/#env-目錄)：

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL
```

```ts import.meta.vitest name="production: pass secrets"
import { Effect, Redacted, Schema } from "effect"

const config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
})

const { url } = await Effect.runPromise(
	Schema.decodeEffect(config)({ url: "postgres://app:secret@db/app" }),
)
String(url) // => "<redacted>"
Redacted.value(url) // => "postgres://app:secret@db/app"
```

| 規則                                        | 避免的問題                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 在行程環境中設定正式環境的變數。            | 行程環境[優先於 `--env-file`](../../cli/#env-檔案)，部署目錄旁過時的 `.env` 無法覆寫它。   |
| 不要把 `.env` 提交到 Git。                  | `graft create` 產生的 `.gitignore` 會忽略它；請保留那一行。                                |
| 絕不公開 fork 樹中的 `input`。              | `Graft.forks` 顯示的是每個 fork 解析後、解碼前的輸入，因此 `!env` 的值會以明文出現在那裡。 |
| 用[健康檢查](#回報健康狀態)找出缺少的變數。 | 缺少變數[只會讓所屬的設定項目失敗](../../config-file/#環境變數)，行程仍繼續執行。          |

## 重試不穩定的資源

沒有 `retry` 的外掛會一直停在
`Failed`，直到它的設定或相依項目變更。依賴網路資源的外掛應該使用一個永不放棄、限制最大延遲並加入隨機抖動的排程，這樣共用同一個資料庫的 fork 就不會同時重新連線：

```ts import.meta.vitest name="production: retry flaky resources"
import { Effect, Ref, Schedule, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class ConnectionRefused extends Schema.TaggedError<
	ConnectionRefused,
	{ readonly brand: unique symbol }
>()("ConnectionRefused", {}) {}

// Stands in for a database that refuses the first connection.
const attempts = Ref.makeUnsafe(0)
const connect = Effect.flatMap(
	Ref.updateAndGet(attempts, (n) => n + 1),
	(n) => (n === 1 ? ConnectionRefused.make({}) : Effect.void),
)

const client = Plugin.make({
	name: "app/client",
	retry: Schedule.min([
		Schedule.exponential("1 second"),
		Schedule.spaced("1 minute"),
	]).pipe(Schedule.jittered),
	apply: () => connect,
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(client)
		yield* fork.state.pipe(
			Stream.map((state) => state._tag),
			Stream.takeUntil((tag) => tag === "Active"),
			Stream.runCollect,
		) // => ["Loading", "Failed", "Loading", "Active"]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

## 回報健康狀態

失敗或等待中的設定項目不會讓行程停止，因此只監看行程的服務管理器會以為應用程式一切正常。請把 fork 狀態發布出來，供健康檢查端點使用：

```ts title="health.ts"
import { Array, Context, Effect, Ref, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

export class Health extends Context.Service<
	Health,
	{ readonly unhealthy: Effect.Effect<ReadonlyArray<string>> }
>()("app/Health") {}

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

export const health = Plugin.make({
	name: "app/health",
	apply: () =>
		Effect.gen(function* () {
			const latest = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Graft.forks.pipe(
				Stream.runForEach((trees) => Ref.set(latest, unhealthy(trees))),
				Plugin.fork,
			)
			yield* Graft.provide(Health, { unhealthy: Ref.get(latest) })
		}),
})
```

將健康監控與這個路由外掛和 [HTTP 伺服器](../../http/)一起載入。掛載注入
`Health`，清單非空時傳回 503：

```ts
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Health } from "./health.ts"

export default Plugin.make({
	name: "app/health-route",
	inject: [Health],
	apply: () =>
		Http.mount(
			HttpRouter.add(
				"GET",
				"/health",
				Effect.gen(function* () {
					const health = yield* Health
					const unhealthy = yield* health.unhealthy
					return HttpServerResponse.empty({
						status: unhealthy.length === 0 ? 200 : 503,
					})
				}),
			),
		).pipe(Effect.asVoid),
})
```

診斷外掛樹請參閱[疑難排解](../troubleshooting/)。

## 依設定項目設定日誌層級

只在正在診斷的設定項目上降低層級，並且只維持到調查結束。設定方式請參閱[依設定項目設定層級](../observability/#依設定項目設定層級)；如何輸出 JSON 日誌或追蹤資料，請參閱[在宿主中選擇輸出](../observability/#在宿主中選擇輸出)。

## 平穩停止

收到 `SIGTERM` 或 <kbd>Ctrl</kbd>+<kbd>C</kbd> 時，`graft start`
會卸載所有外掛。發布服務的外掛會等到消費者停止後才關閉，因此消費者的終結器仍然可以使用這些服務；請參閱[服務撤回流程](../../services/#服務撤回流程)。

| 規則                                                                        | 原因                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 在 `apply` 中以 `Effect.acquireRelease` 或 `Effect.addFinalizer` 持有資源。 | 關閉時只會釋放 `apply` 取得的資源。                                     |
| 在終結器或不可中斷的區段中完成進行中的工作。                                | 消費者排空後，任務會被中斷；被中斷的任務會遺失它手上的工作。            |
| 把服務管理器的停止逾時設得比最慢的終結器更長。                              | `graft start` 沒有整體的關閉逾時。只有 `SIGKILL` 能提前結束卡住的停止。 |

停止卡住時，請參閱[停不下來的停止](../troubleshooting/#停不下來的停止)。

## 不重新啟動就變更設定

直接嵌入的應用程式可編輯 Loader，並明確更新參照。CLI 行程需要在修改後重新啟動。公開部署可在準備和復原時重新解析原始參照，請參閱[單元](../../units/)。

## 升級外掛

安裝套件後，重新建置應用程式模組並重新啟動：

1. **安裝**：執行
   `graft add <package>@<version>`。安裝失敗時，套件檔案會被還原；請參閱[還原](../../cli/#還原)。
2. **重新啟動**行程。執行中的行程會繼續使用它已匯入的模組。
3. **退回**：以同樣的方式安裝先前的版本，然後重新啟動。

| 規則                                         | 避免的問題                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 在 `graft remove` 之前先停用或移除設定項目。 | `graft add <package>` 和 `graft remove` 只變更相依套件；指向已移除套件的設定項目會載入失敗。 |
| 其他工具正在編輯專案時不要安裝。             | 安裝完成前會獨佔套件檔案；請參閱[安裝的所有權](../../cli/#安裝的所有權)。                    |
| 把所有 `@graftland/*` 套件升級到同一個版本。 | Graft 以[同一個版本](../../releases/#版本)發佈所有套件。                                     |
| 讓設定變更保持相容，否則就與新版本一起發布。 | 無法再解碼的設定會讓該設定項目以 `SchemaError` 失敗。                                        |

要在不重新啟動的情況下替換外掛程式碼，請以[監看模式](../../cli/#監看模式)執行
`graft start`，或提交一個[變更](../../transitions/)。

## 以嵌入取代 CLI

需要 `graft start`
沒有提供的功能時，請從你自己的程式執行 Graft：JSON 日誌、tracer、一組固定打包的外掛，或由既有伺服器擁有的服務。請自行建構環境，包括
`graft.yml` 用到的 intercept；嵌入的載入器不會登記任何 intercept：

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: "/app",
		control,
	}).pipe(Layer.provide(NodeServices.layer)),
	Intercept.layer([
		Intercept.make(
			References.MinimumLogLevel,
			Schema.Literals(LogLevel.values),
			(_, level) => level,
		),
	]),
	Logger.layer([Logger.consoleJson]),
)
```

然後在 `Layer.provideMerge(Graft.layer, environment)` 中執行
`Include.Include`，做法如[載入設定檔](../../embedding/#載入設定檔)所示。

| 規則                                   | 原因                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| 把伺服器自己的服務放進 `environment`。 | 外掛像注入其他服務一樣注入它們，它們的生命週期與整個程式相同。         |
| 用 `NodeRuntime.runMain` 執行。        | 它把 `SIGINT` 和 `SIGTERM` 轉為中斷，因此 scope 會關閉，外掛依序停止。 |

## 升級時保留閘道工作階段

把上游工作階段放在閘道[單元](../../units/)中，透過固定[綁定](../../bindings/)注入整合。使用[公開控制介面](../../control/)只替換整合。閘道單元及其工作階段保持不變。

回報成功前記錄結果和原生退出證據。Recovered 表示舊製品的新單元通過試執行。RecoveryFailed 表示整合無法使用。Stuck 保留未解決的預留。[發佈儲存](../../application-releases/)獨立於核心執行記錄資料；控制介面不持久化部署歷史。
