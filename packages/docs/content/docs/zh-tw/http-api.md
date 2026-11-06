---
title: HTTP API
description: 用 Effect HttpApi 路由群組提供即時 OpenAPI 文件與型別化用戶端。
---

`@graftland/plugin-http-api` 將 Effect **HttpApi 路由群組**作為普通外掛部署到
[共用 HTTP 監聽器](../http/)。選用的組合外掛發布即時 OpenAPI 文件。

- 不載入組合外掛也能提供路由；重新啟動它不影響路由群組。
- 載入或卸載路由群組會更新文件與文件介面。
- 第三方透過同一套公開 API 貢獻路由群組、組合文件與提供介面。

## 提供契約

```ts title="contract.ts"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export const Api = HttpApi.make("notes").add(
	HttpApiGroup.make("notes").add(
		HttpApiEndpoint.get("list", "/notes", {
			success: Schema.Array(Schema.String),
		}),
	),
)
```

```ts
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import { Plugin } from "@graftland/graft"
import * as HttpApis from "@graftland/plugin-http-api/HttpApis"

import { Api } from "./contract.ts"

const NotesLive = HttpApiBuilder.group(Api, "notes", (handlers) =>
	handlers.handle("list", () => Effect.succeed(["First note"])),
)
export default Plugin.make({
	name: "graft-plugin-notes",
	apply: () => HttpApis.serve(Api, ["notes"], NotesLive),
})
```

| 規則           | 行為                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 選取的路由群組 | 提供對應的 `HttpApiBuilder.group` 層；多個群組的層可以合併。                                                            |
| 依賴           | 在外掛的 `inject` 中宣告處理器與中介軟體需要的服務。                                                                    |
| 前綴           | 在契約上使用 `.prefix`，路由與文件保持一致。                                                                            |
| API 註解       | 組合外掛提供文件中繼資料；來源 API 的標題不會改名群組標籤。保留群組與端點的註解。                                       |
| 手動提供路由   | `HttpApis.advertise(groups, mount)` 回答 `Groups`。從 `Context.get(yield* Http.mount(routes), Http.Mounted)` 取得掛載。 |

## 設定文件

```yaml title="graft.yml"
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 3000 }
- name: "@graftland/plugin-http-api"
  config:
    title: Notes
    version: 1.0.0
- name: "@graftland/plugin-http-api/scalar"
  config: { path: /docs }
```

| 欄位                              | 預設值                | 含義                           |
| --------------------------------- | --------------------- | ------------------------------ |
| `title`、`version`、`description` | Effect OpenAPI 預設值 | 文件中繼資料。                 |
| `servers`                         | 未設定                | `{ url, description? }` 清單。 |
| `openapi`                         | `/openapi.json`       | 路由路徑，或 `false`。         |

項目可以省略 `config`，使用全部預設值。

## 共用中介軟體

在契約中定義 Effect `HttpApiMiddleware.Service` 並附加到群組。驗證外掛用
`Graft.provide` 發布實作；路由群組外掛在 `inject` 中宣告它。

```ts
import { Effect, Redacted, Schema } from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/http-api"

import { Graft, Plugin } from "@graftland/graft"
import * as HttpApis from "@graftland/plugin-http-api/HttpApis"

class Unauthorized extends Schema.TaggedError<
	Unauthorized,
	{ readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {}
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
	"graft-plugin-notes/Authorization",
	{ error: Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}
const Api = HttpApi.make("private").add(
	HttpApiGroup.make("notes")
		.add(HttpApiEndpoint.get("list", "/private", { success: Schema.String }))
		.middleware(Authorization),
)
export const auth = Plugin.make({
	name: "graft-plugin-notes/auth",
	apply: () =>
		Graft.provide(Authorization, {
			bearer: (effect, { credential }) =>
				Redacted.value(credential) === "example-token"
					? effect
					: Effect.fail(Unauthorized.make({})),
		}),
})
export const notes = Plugin.make({
	name: "graft-plugin-notes/notes",
	inject: [Authorization],
	apply: () =>
		HttpApis.serve(
			Api,
			["notes"],
			HttpApiBuilder.group(Api, "notes", (h) =>
				h.handle("list", () => Effect.succeed("private")),
			),
		),
})
```

| 規則                       | 行為                                       |
| -------------------------- | ------------------------------------------ |
| 同一個中介軟體中的驗證方案 | OR：任一方案可以完成驗證。                 |
| 疊加的中介軟體             | AND：每一個都必須成功。                    |
| `.middleware()`            | 僅涵蓋呼叫前加入的端點。                   |
| 提供者卸載                 | 路由群組進入 `Pending`，路由與文件都消失。 |
| 提供者被替換               | 路由群組用新實作重新建構。                 |

將範例權杖換成你的憑證驗證服務。

## 衝突

| 衝突                           | 路由服務                                | 文件                                       |
| ------------------------------ | --------------------------------------- | ------------------------------------------ |
| 相同方法與等價路徑             | `Http.RouteConflict` 排除所有相關掛載。 | 關聯的群組被排除，直到衝突解除。           |
| 相同群組識別碼                 | 不同路徑的路由仍可用。                  | `GroupConflict` 排除該識別碼下的所有群組。 |
| 重複操作 ID 或不相容的安全方案 | 不同路徑的路由仍可用。                  | `GroupConflict` 排除每一對不相容的群組。   |
| 單個群組無法產生文件           | 路由仍可用。                            | 排除該群組，記錄完整 cause。               |
| 整體文件或介面重新整理失敗     | 路由仍可用。                            | 保留上一次成功的快照，記錄完整 cause。     |

## 生命週期

| 變化               | 結果                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| 群組載入或卸載     | 路由立即改變，文件與介面隨後非同步更新。                                           |
| 組合外掛重新啟動   | 群組保留狀態；文件與依賴它的介面重新啟動。                                         |
| 監聽器重新啟動     | 掛載、`Http.Routes`、組合外掛、`Document` 與介面保留啟用狀態。                     |
| 卸載時請求還在執行 | 請求被中斷，回應標頭尚未送出時通常傳回 503。不可中斷的端點會延遲卸載，直到它完成。 |
| Remote 執行        | 路由群組與監聽器必須在同一行程中執行。                                             |

## 型別化用戶端與測試

```ts
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Api } from "./contract.ts"

export default Plugin.make({
	name: "graft-plugin-notes/client",
	inject: [Http.Server, HttpClient.HttpClient],
	apply: () =>
		Effect.gen(function* () {
			const server = yield* Http.Server
			const client = yield* HttpApiClient.make(Api, { baseUrl: server.url })
			const notes = yield* client.notes.list()
			yield* Effect.log(notes)
		}),
})
```

| API                             | 用途                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `HttpApiMiddleware.layerClient` | 建立用戶端時提供用戶端驗證中介軟體。                                                 |
| `HttpApiTest.groups`            | 不開啟通訊端，用型別化用戶端測試處理器層；提供 `HttpServer.layerServices` 與處理器。 |
| 真實 HTTP 測試                  | 使用 `port: 0` 的監聽器與 `HttpApiClient.make`。                                     |

## 擴充組合與介面

| 擴充           | 契約                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 路由群組貢獻者 | 提供服務期間回答 `HttpApis.Groups`，新增或移除回答後發出 `GroupsChanged`。                                                           |
| 自訂組合外掛   | 收集 `HttpApis.Groups`，重用 Effect `HttpApi` 與 `OpenApi`，記錄失敗 cause，發布 `HttpApis.Document`。變更處理器只通知有歸屬的任務。 |
| 路由過濾       | 讀取群組的 `HttpApis.ServingMount` 註記，只保留其掛載存在於 `Http.Routes.served` 的群組。手動 `advertise` 未提供掛載時無法過濾。     |
| 自訂介面       | 注入 `HttpApis.Document`，在有歸屬的任務中跟隨 `SubscriptionRef` 快照；保持固定掛載，用 `ScopedRef` 替換其應用。                     |
| 內建介面       | 將 `@graftland/plugin-http-api/scalar` 或 `/swagger` 作為同層項目載入。兩者接受 `{ path }`，預設為 `/docs`，資源隨套件提供。         |

組合外掛按群組識別碼排序，使不同載入順序下的標籤與 schema 元件名稱保持穩定。同一 schema 的兩個獨立副本仍可能產生
`User` 與 `User_1` 等名稱。

## Realm

一起隔離監聽器、貢獻事件與文件。`graft.yml` 使用以下鍵字串：

| Token                    | 鍵                                                  |
| ------------------------ | --------------------------------------------------- |
| `Http.Server`            | `@graftland/plugin-http/Http/Server`                |
| `Http.Mounts`            | `@graftland/plugin-http/Http/Mounts`                |
| `Http.MountsChanged`     | `@graftland/plugin-http/Http/MountsChanged`         |
| `Http.Routes`            | `@graftland/plugin-http/Http/Routes`                |
| `Http.Routing`           | `@graftland/plugin-http/Http/Routing`               |
| `HttpApis.Groups`        | `@graftland/plugin-http-api/HttpApis/Groups`        |
| `HttpApis.GroupsChanged` | `@graftland/plugin-http-api/HttpApis/GroupsChanged` |
| `HttpApis.Document`      | `@graftland/plugin-http-api/HttpApis/Document`      |

```yaml
- id: tenant-a
  name: group
  group: true
  isolate: &api-realm
    "@graftland/plugin-http/Http/Server": true
    "@graftland/plugin-http/Http/Routing": true
    "@graftland/plugin-http/Http/Mounts": true
    "@graftland/plugin-http/Http/MountsChanged": true
    "@graftland/plugin-http/Http/Routes": true
    "@graftland/plugin-http-api/HttpApis/Groups": true
    "@graftland/plugin-http-api/HttpApis/GroupsChanged": true
    "@graftland/plugin-http-api/HttpApis/Document": true
  config:
    - id: tenant-a-router
      name: "@graftland/plugin-http/router"
    - id: tenant-a-listener
      name: "@graftland/plugin-http"
      config: { port: 0 }
    - id: tenant-a-composer
      name: "@graftland/plugin-http-api"
    - id: tenant-a-ui
      name: "@graftland/plugin-http-api/scalar"
- id: tenant-b
  name: group
  group: true
  isolate: *api-realm
  config:
    - id: tenant-b-router
      name: "@graftland/plugin-http/router"
    - id: tenant-b-listener
      name: "@graftland/plugin-http"
      config: { port: 0 }
    - id: tenant-b-composer
      name: "@graftland/plugin-http-api"
    - id: tenant-b-ui
      name: "@graftland/plugin-http-api/scalar"
```
