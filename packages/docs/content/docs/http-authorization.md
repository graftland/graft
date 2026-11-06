---
title: HTTP authorization
description:
  Protect a mount with OAuth bearer tokens and publish resource metadata.
---

`@graftland/plugin-http/oauth` publishes an **Authorization** guard and OAuth
protected-resource metadata. Mounts choose their path and required scopes. Token
validation is a separate sibling plugin.

## Configure a resource

Publish an Effect HTTP client for the JWT plugin. Use the public resource URL
even when a proxy forwards to a loopback listener.

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

| Configuration          | Meaning                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `resource`             | Public resource identifier; tokens must include it in their audience.                                               |
| `authorizationServers` | Nonempty list of authorization-server issuer URLs in the metadata document.                                         |
| `issuer`, `audience`   | Exact expected JWT claims.                                                                                          |
| `jwksUrl`              | HTTPS JWKS endpoint without credentials or fragment.                                                                |
| JWT checks             | Signature, expiry, issuer and audience; requires `sub`, `iss`, `aud`, `exp`. Accepts RS256, PS256, ES256 and EdDSA. |

For `https://api.example/mcp`, metadata is served at
`/.well-known/oauth-protected-resource/mcp`; the well-known suffix precedes the
resource path
([RFC 9728 §3.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-3.1)).

## Protect a mount

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

The guard covers the configured path and its descendants; other paths in the
wrapped mount return 404. It accepts bearer tokens only from the Authorization
header. The request’s verified `Principal` wins over a plugin service with the
same key, including in layers that capture their build context.

## Responses

When no scopes are required, the challenge omits `scope`.

| Case                                                | Response and basis                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing or non-Bearer credentials                   | 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` ([RFC 6750 §3](https://www.rfc-editor.org/rfc/rfc6750.html#section-3), [RFC 9728 §5.1](https://www.rfc-editor.org/rfc/rfc9728.html#section-5.1)). |
| Malformed, invalid, expired or wrong-audience token | 401 with `error="invalid_token"` ([RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)); audience binding follows [RFC 9728 §7.4](https://www.rfc-editor.org/rfc/rfc9728.html#section-7.4).        |
| Valid token missing a required scope                | 403 with `error="insufficient_scope"` and the required `scope` ([RFC 6750 §3.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-3.1)).                                                                             |
| JWKS unavailable                                    | 503; `ValidationUnavailable` retains the cause.                                                                                                                                                                        |

## Replace token validation

Publish `TokenValidator` from an ordinary plugin to validate opaque tokens or
use another identity system. Stop the JWT entry before loading its replacement
in the same realm. Authorization and dependent mounts restart with that service;
unrelated routes keep running.

`InvalidToken`, `Unauthorized`, `InsufficientScope` and `ValidationUnavailable`
retain their causes. Tokens enter the validator as `Redacted<string>`. The guard
checks audience and scope even for a third-party validator.

Use the [HTTP isolation keys](../http/#realms), including `Authorization`,
`Principal` and `TokenValidator`, for independent resources. Apply the same
guard to an `HttpApiBuilder.layer` through `Http.mount`; advertise the resulting
mount with `HttpApis.advertise` for [live API documentation](../http-api/).
