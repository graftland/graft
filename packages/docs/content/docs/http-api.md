---
title: HTTP APIs
description:
  Serve Effect HttpApi groups with live OpenAPI documentation and typed clients.
---

`@graftland/plugin-http-api` serves Effect **HttpApi groups** as ordinary
plugins on [the shared HTTP listener](../http/). The optional composer publishes
a live OpenAPI document.

- Groups work without the composer and keep running when it restarts.
- Loading or unloading a group updates the document and documentation UI.
- Third parties can contribute groups, compose documents and provide UIs through
  the same public APIs.

## Serve a contract

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

| Rule            | Behavior                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Selected groups | Supply their `HttpApiBuilder.group` layers; merge layers for several groups.                                                        |
| Dependencies    | Declare handler and middleware services in the plugin's `inject`.                                                                   |
| Prefix          | Put it in the contract with `.prefix`; routes and documentation agree.                                                              |
| API annotations | The composer supplies document metadata; source API titles do not rename group tags. Group and endpoint annotations remain.         |
| Manual serving  | `HttpApis.advertise(groups, mount)` answers `Groups`. Obtain the mount from `Context.get(yield* Http.mount(routes), Http.Mounted)`. |

## Configure documentation

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

| Field                             | Default                 | Meaning                          |
| --------------------------------- | ----------------------- | -------------------------------- |
| `title`, `version`, `description` | Effect OpenAPI defaults | Document metadata.               |
| `servers`                         | Not set                 | List of `{ url, description? }`. |
| `openapi`                         | `/openapi.json`         | Route path, or `false`.          |

An entry may omit `config` to use all defaults.

## Share middleware

Define an Effect `HttpApiMiddleware.Service` in the contract and attach it to a
group. An authentication plugin publishes its implementation with
`Graft.provide`; the group plugin declares it in `inject`.

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

| Rule                          | Behavior                                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| Schemes within one middleware | OR: any one scheme can authenticate.                                 |
| Stacked middlewares           | AND: each must succeed.                                              |
| `.middleware()`               | Covers endpoints added before the call.                              |
| Provider unloads              | The group becomes `Pending`; its routes and documentation disappear. |
| Provider replaced             | The group rebuilds with the new implementation.                      |

Replace the example token with your credential verification service.

## Conflicts

| Conflict                                               | Serving                                             | Documentation                                                       |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------- |
| Same method and equivalent path                        | `Http.RouteConflict` excludes every involved mount. | Associated groups are excluded until the conflict clears.           |
| Same group identifier                                  | Distinct routes still work.                         | `GroupConflict` excludes all groups with that identifier.           |
| Duplicate operation ID or incompatible security scheme | Distinct routes still work.                         | `GroupConflict` excludes each incompatible pair.                    |
| One group's document generation fails                  | Routes still work.                                  | That group is excluded; the full cause is logged.                   |
| Whole document or UI refresh fails                     | Routes still work.                                  | The previous successful snapshot remains; the full cause is logged. |

## Lifetimes

| Change                    | Result                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Group loads or unloads    | Its routes change immediately; document and UI updates follow asynchronously.                                |
| Composer restarts         | Groups keep their state. Its document and dependent UIs restart.                                             |
| Listener restarts         | Mounts, `Http.Routes`, composer, `Document` and UIs keep their activations.                                  |
| Request running at unload | Interrupted, normally with 503 before headers. An uninterruptible endpoint delays unload until it completes. |
| Remote execution          | A group and its listener must run in the same process.                                                       |

## Typed clients and tests

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

| API                             | Use                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HttpApiMiddleware.layerClient` | Supply client-side authentication middleware while making the client.                                                  |
| `HttpApiTest.groups`            | Test handler layers with a typed client without opening a socket; provide `HttpServer.layerServices` and the handlers. |
| Real HTTP tests                 | Use a listener with `port: 0` and `HttpApiClient.make`.                                                                |

## Extend composition and UIs

| Extension              | Contract                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group contributor      | Answer `HttpApis.Groups` while serving. Emit `GroupsChanged` after adding or removing the answer.                                                                           |
| Custom composer        | Settle `HttpApis.Groups`, reuse Effect `HttpApi` and `OpenApi`, log failed causes, and publish `HttpApis.Document`. Change handlers only signal an owned task.              |
| Served-route filtering | Read each group’s `HttpApis.ServingMount` annotation and keep it only when its mount occurs in `Http.Routes.served`. Manual `advertise` without a mount cannot be filtered. |
| Custom UI              | Inject `HttpApis.Document`, follow its `SubscriptionRef` snapshots in an owned task, and keep a fixed mount while swapping its app with `ScopedRef`.                        |
| Built-in UIs           | Load `@graftland/plugin-http-api/scalar` or `/swagger` as a sibling entry. Both accept `{ path }`, defaulting to `/docs`, and bundle assets locally.                        |

The composer sorts group identifiers so tags and schema component names stay
stable across load orders. Two distinct copies of a schema can still produce
names such as `User` and `User_1`.

## Realms

Isolate the listener, contributions and document together. Key strings for
`graft.yml`:

| Token                    | Key                                                 |
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
