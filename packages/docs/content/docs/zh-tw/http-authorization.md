---
title: HTTP 授權
description: 用 OAuth bearer 權杖保護掛載並發布資源中繼資料。
---

`@graftland/plugin-http/oauth` 發布 **Authorization**
守衛和 OAuth 受保護資源中繼資料。掛載選擇路徑與所需 scope，權杖驗證由獨立的同層外掛提供。

## 設定資源

為 JWT 外掛發布 Effect
HTTP 用戶端。即使代理轉送到回環監聽器，也使用公開資源 URL。

```ts title="http-client.ts"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

import { Graft, Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "graft-plugin-gateway/http-client",
	apply: () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(FetchHttpClient.layer)
			yield* Graft.provide(
				HttpClient.HttpClient,
				Context.get(context, HttpClient.HttpClient),
			)
		}),
})
```

```yaml title="graft.yml"
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 3000 }
- name: ./http-client.ts
- name: "@graftland/plugin-http/oauth/jwt"
  config:
    issuer: https://issuer.example
    audience: https://api.example/mcp
    jwksUrl: https://issuer.example/jwks
- name: "@graftland/plugin-http/oauth"
  config:
    resource: https://api.example/mcp
    authorizationServers: [https://issuer.example]
```

| 設定                   | 含義                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `resource`             | 公開資源識別碼；權杖 audience 必須包含它。                                                             |
| `authorizationServers` | 中繼資料中的授權伺服器 issuer URL 非空清單。                                                           |
| `issuer`、`audience`   | JWT 中必須精確符合的宣告。                                                                             |
| `jwksUrl`              | 不帶憑證或片段的 HTTPS JWKS 位址。                                                                     |
| JWT 檢查               | 簽章、有效期、issuer 與 audience；要求 `sub`、`iss`、`aud`、`exp`。接受 RS256、PS256、ES256 與 EdDSA。 |

資源為 `https://api.example/mcp` 時，在
`/.well-known/oauth-protected-resource/mcp`
提供中繼資料；well-known 後綴位於資源路徑之前（[RFC 9728 §3.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-3.1)）。

## 保護掛載

```ts
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import { Authorization, Principal } from "@graftland/plugin-http/Authorization"
import * as Http from "@graftland/plugin-http/Http"

export default Plugin.make({
	name: "graft-plugin-gateway/protected",
	inject: [Authorization],
	apply: () =>
		Effect.gen(function* () {
			const authorization = yield* Authorization
			const guard = authorization.protect({
				path: "/mcp",
				scopes: ["tools:read"],
			})
			yield* Http.mount(
				HttpRouter.add(
					"GET",
					"/mcp",
					Effect.map(Principal, (principal) =>
						HttpServerResponse.text(principal.subject),
					),
				).pipe(Layer.provide(guard.layer)),
			)
		}),
})
```

守衛涵蓋設定的路徑及其子路徑；被包裝掛載的其他路徑傳回 404。只接受 Authorization 標頭中的 bearer 權杖。請求中驗證過的
`Principal` 優先於同名外掛服務，包括擷取建構上下文的層。

## 回應

未要求任何 scope 時，challenge 省略 `scope`。

| 情況                                 | 回應與依據                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺少 bearer 憑證或使用其他方案       | 401，帶有 `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`（[RFC 6750 §3](https://www.rfc-editor.org/rfc/rfc6750.html#section-3)、[RFC 9728 §5.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1)）。 |
| 格式錯誤、無效、過期或 audience 不符 | 401，帶有 `error="invalid_token"`（[RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)）；audience 綁定遵循 [RFC 9728 §7.4](https://www.rfc-editor.org/rfc/rfc9728.html#section-7.4)。               |
| 有效權杖缺少所需 scope               | 403，帶有 `error="insufficient_scope"` 與所需 `scope`（[RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)）。                                                                                       |
| JWKS 無法使用                        | 503；`ValidationUnavailable` 保留 cause。                                                                                                                                                                                 |

## 替換權杖驗證

普通外掛可以發布
`TokenValidator`，驗證不透明權杖或接入其他身分系統。在同一 realm 載入替代外掛前先停止 JWT 項目。授權與依賴它的掛載隨服務重啟；無關路由繼續執行。

`InvalidToken`、`Unauthorized`、`InsufficientScope` 與 `ValidationUnavailable`
保留 cause。驗證器接收 `Redacted<string>`
權杖。即使使用第三方驗證器，守衛仍檢查 audience 與 scope。

獨立資源使用 [HTTP 隔離鍵](../http/#realm)，包括 `Authorization`、`Principal` 與
`TokenValidator`。透過 `Http.mount` 為 `HttpApiBuilder.layer` 套用同一守衛；用
`HttpApis.advertise` 發布產生的掛載以取得[即時 API 文件](../http-api/)。
