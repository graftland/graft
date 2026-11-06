---
title: 在正式環境執行
description: 啟動、保護、監督、重新設定、停止並升級長時間執行的 Graft 應用程式。
---

正式環境中的 Graft 應用程式是一個長時間執行的行程：`graft start`，或你自己以
`Graft.layer` 建構的程式。它由服務管理器執行，服務管理器負責重新啟動它，並以
`SIGTERM` 停止它。

## 不帶 `--watch` 啟動

正式環境請執行 `graft start graft.yml`，`--watch`
留給開發使用。所有選項都列在[命令列](../../cli/#graft-start)頁面。

| 項目                    | 不帶 `--watch`                                                        | 帶 `--watch`                                                                  |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 外掛程式碼變更          | 需要重新啟動。                                                        | [熱重載](../../hot-reload/)，但它[不適用於正式環境](../../hot-reload/#限制)。 |
| 手動編輯 `graft.yml`    | 在下次重新啟動或下次透過 Loader 編輯時套用。                          | 儲存時套用。                                                                  |
| `--env-file` 的內容     | 只在啟動時讀取一次。                                                  | [儲存時重新讀取](../../cli/#env-檔案)。                                       |
| 啟動時 `graft.yml` 無效 | 行程[以非零狀態碼結束](../../cli/#第一份設定無效)，部署會明確地失敗。 | 行程持續等待，不執行任何設定項目。                                            |
| 失敗的設定項目          | 在變更時、依其 `retry` 排程，或由 `loader.retry` 重試。               | 每次模組重載後也會重試。                                                      |

為每個設定項目指定 `id`，或在 Graft
[補上缺少的 id](../../config-file/#設定項目欄位) 後提交
`graft.yml`，這樣唯讀或剛部署的檔案就不會在啟動時被改寫。

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

沒有 `retry` 的外掛會一直停在 `Failed`，直到它的設定或相依項目變更，或執行
`loader.retry`。依賴網路資源的外掛應該使用一個永不放棄、限制最大延遲並加入隨機抖動的排程，這樣共用同一個資料庫的 fork 就不會同時重新連線：

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

- 何時該在任務內重試單一呼叫、而不是重試整個 fork，請參閱[讓 fork 失敗並重試](../effect/#讓-fork-失敗並重試)。
- 設定項目沒有 `retry` 欄位，所以排程屬於外掛。`name: remote`
  的設定項目請參閱[限制失敗範圍](#限制失敗範圍)。

## 限制失敗範圍

失敗會停止一個 activation，並重新啟動其服務的消費者（[服務撤回流程](../../services/#服務撤回流程)）。依可能出錯的地方選擇邊界：

| 可能失敗的部分                                               | 邊界                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 各自獨立失敗的兩項資源                                       | 分成兩個外掛。[一個任務失敗](../../plugins/#任務失敗時)會讓整個 activation 失敗。 |
| 某個租戶或實例的相依項目                                     | 每個實例一個[領域](../../isolation/)。只有該領域內的消費者會等待。                |
| 當機、記憶體洩漏、`process.exit`，或在 Effect 之外拋出的例外 | Remote `local`：一個[子行程](../../remote/overview/)。                            |
| 阻塞事件迴圈的 CPU 密集工作                                  | Remote `worker`：同一行程內的 Node worker。                                       |
| 另一台機器上的硬體、資料或網路                               | 一個 [runner](../../remote/runners/)。                                            |
| 程式碼被允許做的事                                           | 放在容器或虛擬機器中的 runner；[Remote](../../remote/overview/) 不限制權限。      |

在 Effect 之外拋出的例外，例如在原生回呼中拋出的，可能終止整個行程。在行程內，只有 Effect 的失敗會被限制在邊界內。

YAML 中的 `name: remote` 設定項目沒有 `retry`，因此當機的子行程會一直停在
`Failed`，直到設定項目變更或執行
`loader.retry`。要讓它自動重新啟動，請從模組匯出帶有 `retry` 的
`Remote.plugin`，並改為載入該模組：

```ts title="src/greeterHost.ts"
import { Schedule, Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ readonly greeting: typeof Schema.String }>
>

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	implementation: new URL("./greeter.js", import.meta.url).href,
	connect: { local: {} },
	retry: Schedule.spaced("5 seconds"),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./dist/greeterHost.js
  config:
    greeting: Hello
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

| 規則                                                                                    | 原因                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在 `apply` 中以 `Effect.acquireRelease` 或 `Effect.addFinalizer` 持有資源。             | 關閉時只會釋放 `apply` 取得的資源。                                                                                                                                             |
| 在終結器或不可中斷的區段中完成進行中的工作。                                            | 消費者排空後，任務會被中斷；被中斷的任務會遺失它手上的工作。                                                                                                                    |
| 把服務管理器的停止逾時設得比最慢的終結器更長。                                          | `graft start` 沒有整體的關閉逾時。只有 `SIGKILL` 能提前結束卡住的停止。                                                                                                         |
| 遠端外掛的 finalizer 需要超過預設 5 秒時，在 `Remote.plugin` 上調高 `shutdownTimeout`。 | YAML 的 `remote` 設定項目固定為 5 秒；要變更它，請像[限制失敗範圍](#限制失敗範圍)中那樣從模組匯出 `Remote.plugin`。請參閱[逾時與預設值](../../remote/lifecycle/#逾時與預設值)。 |

停止卡住時，請參閱[停不下來的停止](../troubleshooting/#停不下來的停止)。

## 不重新啟動就變更設定

透過 [Loader API](../../loader-api/)
變更執行中的應用程式，而不是重新啟動它。只有變更的設定項目會重新載入，其餘的保留原有的連線和狀態。哪些欄位的變更會更新、哪些會重新載入，請參閱[執行期間的變更](../../config-file/#執行期間的變更)；`remote`
設定項目一律會重新啟動它的外掛行程。

- 編輯會寫入
  `graft.yml`。替換該檔案的部署會丟棄這些編輯，因此請把已部署的檔案當成狀態看待，或把變更寫回你的儲存庫。
- 執行中行程的環境無法從外部變更，因此輪替設定在那裡的機密需要重新啟動。`loader.retry`
  會[重新讀取 `!env` 的值](../../config-file/#何時重新讀取值)，但只有在值的來源有變更時才有幫助，例如
  `--watch` 下的 `--env-file` 或 `--env-dir`。
- 持有連線或快取的外掛應支援[原地更新](../../plugins/#原地更新)，這樣編輯設定時就不會中斷它們。

## 升級外掛

`node_modules` 中的變更永遠不會觸發重載，無論是否使用
`--watch`。升級的方式是安裝後重新啟動：

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

要在不重新啟動的情況下替換外掛程式碼，嵌入 Graft 的宿主應用程式可以呼叫
[`Graft.replace`](../../replace/)；
[checkout-upgrade](https://github.com/graftland/graft/tree/main/samples/checkout-upgrade)
範例示範了如何在負載下這麼做。

## 以嵌入取代 CLI

需要 `graft start`
沒有提供的功能時，請從你自己的程式執行 Graft：JSON 日誌、tracer、一組固定打包的外掛，或由既有伺服器擁有的服務。請自行建構環境，包括
`graft.yml` 用到的 intercept；嵌入的載入器不會登記任何 intercept：

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: process.cwd(),
		importer: (specifier) => import(specifier),
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

| 規則                                                         | 原因                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 把伺服器自己的服務放進 `environment`。                       | 外掛像注入其他服務一樣注入它們，它們的生命週期與整個程式相同。         |
| 用 `NodeRuntime.runMain` 執行。                              | 它把 `SIGINT` 和 `SIGTERM` 轉為中斷，因此 scope 會關閉，外掛依序停止。 |
| 載入 `remote` 設定項目時加入 `SecureRandom.layerWebCrypto`。 | Remote 需要它；`graft start` 會替你提供。                              |

## 升級時保留閘道工作階段

把上游連線放在宿主擁有的外掛中，由獨立消費者注入整合契約。整合使用擷取的產物，在直連 Worker 或子行程中執行。
[執行轉換](../../transitions/) 在切換世代時保留消費者的服務物件。

回報成功前記錄結果和結束證據。`Recovered` 表示舊產物的新單元正在服務；
`RecoveryFailed` 使整合無法使用，但宿主仍可保留工作階段。`Stuck`
需要操作人員介入。另行儲存下次啟動宿主時需要的產物：transition 不持久化 Loader 設定。

## 版本化受管部署

使用[應用程式發佈](../../application-releases/)一起持久化受管整合的產物和編碼後的設定。將閘道放在發佈外掛子樹之外。保護儲存和 Unix
socket 目錄，並讓一個應用程式獨占儲存。崩潰後日誌選擇最後完整接受的發佈。跨執行個體發佈仍由現有部署工具負責。
