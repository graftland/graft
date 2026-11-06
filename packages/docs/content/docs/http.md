---
title: HTTP server
description: Mount plugin routes on a shared HTTP server.
---

`@graftland/plugin-http` runs one HTTP listener. A **mount** is a set of Effect
`HttpRouter` routes owned by a plugin.

- Routes appear and disappear while the listener keeps running.
- Unloading a mount stops its requests and response streams.
- Third-party plugins use the same public APIs as first-party plugins.

## Configuration

```yaml title="graft.yml"
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config:
    port: 3000
```

| Key    | Default     | Meaning                                                                                         |
| ------ | ----------- | ----------------------------------------------------------------------------------------------- |
| `port` | Required    | Integer or decimal digit string from 0 to 65535; accepts `!env`. Use 0 for an OS-assigned port. |
| `host` | `127.0.0.1` | Bind address.                                                                                   |

Use the full package name in configuration. `Http.Server` publishes the actual
`url` and `address`; inject it only when a plugin needs to restart with the
server.

## Mount routes

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

Use `HttpRouter.add`, `addAll` or `use`. Handlers can read `RouteContext` for
path parameters. List handler dependencies in the mounting plugin's `inject`.

| API                         | Use within a mount                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `HttpRouter.middleware`     | Wrap routes with authorization or response changes; provide its `.layer` to the routes.                                   |
| `HttpRouter.cors`           | Merge it with the route layer for this mount's preflight policy.                                                          |
| `HttpRouter.provideRequest` | Build a layer when mounting and provide its services to requests; it cannot read the current request during construction. |
| `Http.mount`                | Build the layer and return its services; own requests until unload.                                                       |
| `Http.advertise`            | Advertise an existing app; the caller must own its resources and request lifetime.                                        |

See the [API reference](/reference/plugin-http/http/readme/) and the runnable
[http-gateway sample](https://github.com/graftland/graft/tree/main/samples/http-gateway).

## Routing and conflicts

| Request or registration                                           | Result                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `HEAD` without a HEAD route                                       | Falls back to GET; the body is omitted.                                      |
| Method miss, one mount owns the path                              | That mount handles it, including its CORS preflight policy.                  |
| Method miss, several mounts own the path                          | 404.                                                                         |
| Unknown path                                                      | Empty 404.                                                                   |
| Same method and equivalent paths, such as `/a/:id` and `/a/:name` | `RouteConflict` warning; every involved mount is excluded in full.           |
| `*` and GET on the same path                                      | Conflict.                                                                    |
| Wildcard and a more specific path                                 | Both remain available.                                                       |
| Duplicate within one `Http.mount`                                 | The mounting plugin fails to start.                                          |
| Invalid manual `Http.advertise` contribution                      | `InvalidMount` warning with its original cause; only that mount is excluded. |

Removing a conflicting mount makes the remaining non-conflicting mounts
available. A method miss does not automatically produce 405; the mount must
supply that response.

## Lifetimes

| Change                             | Result                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Listener changes or is replaced    | The listener and plugins that inject `Http.Server` restart. Mounts, `Http.Routes`, composers and UIs keep their activations. |
| Mount unloads                      | Its routes disappear before its resources close.                                                                             |
| Route plugin hot-swaps             | Its old routes leave and its replacement mounts. The listener stays running.                                                 |
| Replacement rolls back             | The previous plugin starts again and remounts its routes.                                                                    |
| Required dependency disappears     | The mount unloads and its plugin becomes `Pending`; routes return when it activates.                                         |
| Handler is still running on unload | It is interrupted and normally receives 503 before headers are sent.                                                         |
| Response body is already streaming | The connection is cut; its status cannot be changed.                                                                         |
| `Mounts` events                    | In-process only. The routing core, mounts and listener share a process.                                                      |

## Realms

Give each server and its routes a shared [isolation boundary](../isolation/):

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

A second server in the same realm conflicts on its published services. Isolate
the five HTTP keys; include the authorization keys when using OAuth.

| Token                | Key for `graft.yml`                                   |
| -------------------- | ----------------------------------------------------- |
| `Http.Server`        | `@graftland/plugin-http/Http/Server`                  |
| `Http.Mounts`        | `@graftland/plugin-http/Http/Mounts`                  |
| `Http.MountsChanged` | `@graftland/plugin-http/Http/MountsChanged`           |
| `Http.Routes`        | `@graftland/plugin-http/Http/Routes`                  |
| `Http.Routing`       | `@graftland/plugin-http/Http/Routing`                 |
| `Authorization`      | `@graftland/plugin-http/Authorization/Authorization`  |
| `Principal`          | `@graftland/plugin-http/Authorization/Principal`      |
| `TokenValidator`     | `@graftland/plugin-http/Authorization/TokenValidator` |

Set `PORT=0` for an available port.

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

## Security

The default bind is loopback. There is no server-wide authentication. For
external access, use a reverse proxy and per-mount `HttpRouter.middleware` as
needed:

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

Replace the example token with a credential service. Mounts inject the guard;
withdrawing it makes them `Pending`. An operator cannot guard a mount they do
not own unless that plugin opts into the guard service.

## Other listeners and route state

| API                              | Use                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Http.Routing`                   | The routing core publishes its request `handle`. A sibling listener injects it, serves it with Effect’s `HttpServer.serveEffect`, and publishes `Http.Server`. |
| `Http.Routes`                    | Inject the `SubscriptionRef` to observe `{ served, conflicts }` after each route synchronization.                                                              |
| `@graftland/plugin-http/Testing` | Run `listener(url)` in an isolated test with Graft and an HTTP client. It checks mount, unload, conflicts and 503 on unload.                                   |

Third parties provide additional listeners such as TLS or HTTP/2. For
schema-first routes and live documentation, see [HTTP APIs](../http-api/).

For verified bearer tokens and resource metadata, use
[HTTP authorization](../http-authorization/).
