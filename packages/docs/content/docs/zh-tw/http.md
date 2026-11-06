---
title: HTTP 伺服器
description: 將外掛路由掛載到共用 HTTP 伺服器。
---

`@graftland/plugin-http` 執行一個 HTTP 監聽器。**掛載**是一組由外掛擁有的 Effect
`HttpRouter` 路由。

- 路由增減時，監聽器持續執行。
- 卸載掛載會中斷它的請求與回應串流。
- 第三方外掛與第一方外掛使用相同的公開 API。

## 設定

```yaml title="graft.yml"
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config:
    port: 3000
```

| 鍵     | 預設值      | 含義                                                                       |
| ------ | ----------- | -------------------------------------------------------------------------- |
| `port` | 必填        | 0 到 65535 的整數或僅含十進位數字的字串，支援 `!env`；0 讓系統分配連接埠。 |
| `host` | `127.0.0.1` | 綁定位址。                                                                 |

設定中使用完整套件名稱。`Http.Server` 提供實際的 `url` 和
`address`；只有需要隨伺服器重新啟動的外掛才注入它。

## 掛載路由

```ts
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

export default Plugin.make({
	name: "graft-plugin-health",
	apply: () =>
		Http.mount(
			HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
		).pipe(Effect.asVoid),
})
```

使用 `HttpRouter.add`、`addAll` 或 `use`。處理器從 `RouteContext`
讀取路徑參數。處理器的依賴要列在掛載外掛的 `inject` 中。

| API                         | 在掛載中的用途                                               |
| --------------------------- | ------------------------------------------------------------ |
| `HttpRouter.middleware`     | 為路由加入授權或修改回應；將它的 `.layer` 提供給路由。       |
| `HttpRouter.cors`           | 與路由層合併，設定該掛載的預檢策略。                         |
| `HttpRouter.provideRequest` | 掛載時建構層，並將服務提供給請求；建構時無法讀取目前的請求。 |
| `Http.mount`                | 建構層並傳回服務；管理請求直到卸載。                         |
| `Http.advertise`            | 發布既有應用；呼叫者負責資源與請求的生命週期。               |

參閱 [API 參考](../reference/plugin-http/http/readme/)與可執行的
[http-gateway 範例](https://github.com/graftland/graft/tree/main/samples/http-gateway)。

## 路由與衝突

| 請求或註冊                                    | 結果                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| 沒有 HEAD 路由的 `HEAD`                       | 回退至 GET，不傳回回應本體。                            |
| 方法未匹配，路徑只屬於一個掛載                | 交給該掛載處理，包括它的 CORS 預檢策略。                |
| 方法未匹配，路徑屬於多個掛載                  | 404。                                                   |
| 未知路徑                                      | 空的 404。                                              |
| 同一方法的等價路徑，如 `/a/:id` 和 `/a/:name` | 記錄 `RouteConflict` 警告，完整排除所有衝突的掛載。     |
| 同一路徑上的 `*` 和 GET                       | 衝突。                                                  |
| 萬用路由與更具體的路徑                        | 兩者都可用。                                            |
| 同一 `Http.mount` 內重複註冊                  | 掛載外掛啟動失敗。                                      |
| 無效的手動 `Http.advertise` 貢獻              | 記錄帶原始 cause 的 `InvalidMount` 警告，只排除該掛載。 |

移除衝突的掛載後，其餘不再衝突的掛載恢復可用。方法未匹配不會自動傳回 405；該回應需要掛載自行提供。

## 生命週期

| 變化                   | 結果                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| 監聽器修改或替換       | 監聽器和注入 `Http.Server` 的外掛重啟。掛載、`Http.Routes`、組合外掛與介面保留啟用狀態。 |
| 卸載掛載               | 路由先消失，再關閉資源。                                                                 |
| 熱替換路由外掛         | 舊路由移除，新外掛掛載路由；監聽器繼續執行。                                             |
| 替換回滾               | 舊外掛重新啟動並掛載路由。                                                               |
| 必要依賴消失           | 卸載掛載，外掛進入 `Pending`；啟用後路由恢復。                                           |
| 卸載時處理器仍在執行   | 請求被中斷；尚未送出回應標頭時通常傳回 503。                                             |
| 回應本體已開始串流傳輸 | 連線被切斷；無法再更改狀態碼。                                                           |
| `Mounts` 事件          | 僅限行程內。路由核心、掛載與監聽器位於同一行程。                                         |

## Realm

將每個伺服器及其路由放在同一個[隔離邊界](../isolation/)中：

```ts
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Graft, Plugin } from "@graftland/graft"
import server from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"
import router from "@graftland/plugin-http/router"

const tenant = Plugin.make({
	name: "graft-plugin-tenant",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(router)
			yield* Graft.plugin(server, { port: 3001 })
			yield* Http.mount(
				HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
			)
		}),
})

export const loadTenant = Graft.plugin(tenant, undefined, {
	isolate: [
		Http.Server,
		Http.Mounts,
		Http.MountsChanged,
		Http.Routes,
		Http.Routing,
	],
})
```

同一 realm 中的第二個伺服器會在發布的服務上衝突。必須隔離五個 HTTP 鍵；使用 OAuth 時也隔離授權鍵。

| Token                | `graft.yml` 中的鍵                                    |
| -------------------- | ----------------------------------------------------- |
| `Http.Server`        | `@graftland/plugin-http/Http/Server`                  |
| `Http.Mounts`        | `@graftland/plugin-http/Http/Mounts`                  |
| `Http.MountsChanged` | `@graftland/plugin-http/Http/MountsChanged`           |
| `Http.Routes`        | `@graftland/plugin-http/Http/Routes`                  |
| `Http.Routing`       | `@graftland/plugin-http/Http/Routing`                 |
| `Authorization`      | `@graftland/plugin-http/Authorization/Authorization`  |
| `Principal`          | `@graftland/plugin-http/Authorization/Principal`      |
| `TokenValidator`     | `@graftland/plugin-http/Authorization/TokenValidator` |

設定 `PORT=0` 以分配可用連接埠。

```yaml
- id: tenant
  name: group
  group: true
  isolate:
    "@graftland/plugin-http/Http/Server": true
    "@graftland/plugin-http/Http/Mounts": true
    "@graftland/plugin-http/Http/MountsChanged": true
    "@graftland/plugin-http/Http/Routes": true
    "@graftland/plugin-http/Http/Routing": true
    "@graftland/plugin-http/Authorization/Authorization": true
    "@graftland/plugin-http/Authorization/Principal": true
    "@graftland/plugin-http/Authorization/TokenValidator": true
  config:
    - id: tenant-router
      name: "@graftland/plugin-http/router"
    - id: tenant-listener
      name: "@graftland/plugin-http"
      config: { port: !env PORT }
```

## 安全

預設只綁定回環位址，不提供伺服器級身分驗證。對外提供服務時，使用反向代理，並視需要為掛載設定
`HttpRouter.middleware`：

```ts import.meta.vitest name="http: injected guard"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { Event, Graft, Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

const guard = HttpRouter.middleware((app) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		if (request.headers["authorization"] !== "Bearer example-token") {
			return HttpServerResponse.empty({ status: 401 })
		}
		return yield* app
	}),
)

class Guard extends Context.Service<Guard, typeof guard>()(
	"graft-plugin-private/Guard",
) {}
export const auth = Plugin.make({
	name: "graft-plugin-private/auth",
	apply: () => Graft.provide(Guard, guard),
})

const protectedRoute = Plugin.make({
	name: "graft-plugin-private",
	inject: [Guard],
	apply: () =>
		Effect.gen(function* () {
			const guard = yield* Guard
			yield* Http.mount(
				HttpRouter.add(
					"GET",
					"/private",
					HttpServerResponse.text("private"),
				).pipe(Layer.provide(guard.layer)),
			)
		}),
})

const status = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(auth)).await
		yield* (yield* Graft.plugin(protectedRoute)).await
		const answers = yield* Event.settle(Http.Mounts)
		const answer = answers[0]!
		if (Exit.isFailure(answer))
			return yield* Effect.failCause(answer.cause).pipe(Effect.orDie)
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Mount erases route errors; this doctest turns them into reported defects
		const request = yield* answer.value.handle.pipe(
			Effect.orDie,
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(new Request("http://example.com/private")),
			),
			Effect.forkScoped,
		)
		return (yield* Fiber.join(request)).status
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
status // => 401
```

將範例權杖換成憑證服務。掛載注入守衛；撤回守衛後進入
`Pending`。除非掛載外掛主動接受守衛服務，維運者無法用它保護不屬於自己的掛載。

## 其他監聽器與路由狀態

| API                              | 用途                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Http.Routing`                   | 路由核心發布請求 `handle`。同層監聽器注入它，用 Effect 的 `HttpServer.serveEffect` 提供服務，再發布 `Http.Server`。 |
| `Http.Routes`                    | 注入 `SubscriptionRef`，觀察每次路由同步後的 `{ served, conflicts }`。                                              |
| `@graftland/plugin-http/Testing` | 在提供 Graft 與 HTTP 用戶端的隔離測試中執行 `listener(url)`，檢查掛載、卸載、衝突與卸載時的 503。                   |

第三方提供 TLS、HTTP/2 等其他監聽器。基於 schema 的路由與即時文件見
[HTTP API](../http-api/)。

權杖驗證與資源中繼資料見 [HTTP 授權](../http-authorization/)。
