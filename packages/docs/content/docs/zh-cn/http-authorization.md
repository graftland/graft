---
title: HTTP 授权
description: 用 OAuth bearer 令牌保护挂载并发布资源元数据。
---

`@graftland/plugin-http/oauth` 发布 **Authorization**
守卫和 OAuth 受保护资源元数据。挂载选择路径和所需 scope，令牌验证由独立的同级插件提供。

## 配置资源

为 JWT 插件发布 Effect
HTTP 客户端。即使代理转发到回环监听器，也使用公开资源 URL。

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

| 配置                   | 含义                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `resource`             | 公开资源标识；令牌 audience 必须包含它。                                                               |
| `authorizationServers` | 元数据中的授权服务器 issuer URL 非空列表。                                                             |
| `issuer`、`audience`   | JWT 中必须精确匹配的声明。                                                                             |
| `jwksUrl`              | 不带凭证或片段的 HTTPS JWKS 地址。                                                                     |
| JWT 检查               | 签名、有效期、issuer 和 audience；要求 `sub`、`iss`、`aud`、`exp`。接受 RS256、PS256、ES256 和 EdDSA。 |

资源为 `https://api.example/mcp` 时，在
`/.well-known/oauth-protected-resource/mcp`
提供元数据；well-known 后缀位于资源路径之前（[RFC 9728 §3.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-3.1)）。

## 保护挂载

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

守卫覆盖配置的路径及其子路径；被包装挂载的其他路径返回 404。只接受 Authorization 头中的 bearer 令牌。请求中验证过的
`Principal` 优先于同名插件服务，包括捕获构建上下文的层。

## 响应

未要求任何 scope 时，challenge 省略 `scope`。

| 情况                                   | 响应与依据                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺少 bearer 凭证或使用其他方案         | 401，携带 `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`（[RFC 6750 §3](https://www.rfc-editor.org/rfc/rfc6750.html#section-3)、[RFC 9728 §5.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1)）。 |
| 格式错误、无效、过期或 audience 不匹配 | 401，携带 `error="invalid_token"`（[RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)）；audience 绑定遵循 [RFC 9728 §7.4](https://www.rfc-editor.org/rfc/rfc9728.html#section-7.4)。               |
| 有效令牌缺少所需 scope                 | 403，携带 `error="insufficient_scope"` 与所需 `scope`（[RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)）。                                                                                       |
| JWKS 不可用                            | 503；`ValidationUnavailable` 保留 cause。                                                                                                                                                                                 |

## 替换令牌验证

普通插件可以发布
`TokenValidator`，验证不透明令牌或接入其他身份系统。在同一 realm 加载替代插件前先停止 JWT 条目。授权和依赖它的挂载随服务重启；无关路由继续运行。

`InvalidToken`、`Unauthorized`、`InsufficientScope` 和 `ValidationUnavailable`
保留 cause。验证器接收 `Redacted<string>`
令牌。即使使用第三方验证器，守卫仍检查 audience 和 scope。

独立资源使用 [HTTP 隔离键](../http/#realm)，包括 `Authorization`、`Principal` 和
`TokenValidator`。通过 `Http.mount` 为 `HttpApiBuilder.layer` 应用同一守卫；用
`HttpApis.advertise` 发布生成的挂载以获得[实时 API 文档](../http-api/)。
