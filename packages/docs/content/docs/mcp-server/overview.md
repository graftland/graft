---
title: MCP server
description: Compose an MCP server from a core, transports and contributors.
---

`@graftland/plugin-mcp-server` serves tools, resources and prompts through
Effect's MCP server. The **core** publishes `Server`; sibling transport plugins
consume it. Contributors load and unload without reconnecting clients.

## Run stdio

```yaml
- name: "@graftland/plugin-mcp-server"
  config: { name: notes, version: 1.0.0 }
- name: "@graftland/plugin-mcp-server/stdio"
- name: ./plugins/notes.ts
```

Run `graft start --stdio`. Use `Effect.log*` for logs; stdout belongs to the
protocol, which the kernel [lends to this unit](../../cli/#protocol-output). The
[sample](https://github.com/graftland/graft/tree/main/samples/mcp-tools)
includes a runnable client configuration.

| Entry                                | Short name         | Responsibility                |
| ------------------------------------ | ------------------ | ----------------------------- |
| `@graftland/plugin-mcp-server`       | `mcp-server`       | Publishes server options      |
| `@graftland/plugin-mcp-server/stdio` | `mcp-server/stdio` | Runs Effect's stdio server    |
| `@graftland/plugin-mcp-server/http`  | `mcp-server/http`  | Mounts Streamable HTTP routes |

## Serve HTTP

Add the shared [HTTP router and listener](../../http/) beside the core, and run
this configuration as one long-lived `graft start`. Keep stdio in its own
configuration: an MCP client starts one stdio process per session, and a fixed
port would clash. Both configurations can list the same contributors.

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: "@graftland/plugin-mcp-server"
  config: { name: notes, version: 1.0.0 }
- name: "@graftland/plugin-mcp-server/http"
  config:
    path: /mcp
    allowedOrigins: [https://app.example.com]
- name: ./plugins/notes.ts
```

| Field                  | Default | Rule                                                                               |
| ---------------------- | ------- | ---------------------------------------------------------------------------------- |
| `path`                 | `/mcp`  | Endpoint on the shared router                                                      |
| `allowedOrigins`       | Absent  | Reject any `Origin` not explicitly listed; requests without it remain valid        |
| `authorization.scopes` | Absent  | When configured, require the shared `Authorization` service and every listed scope |

### Require authorization

Replace the HTTP entry above with the protected entry below and add the OAuth
plugins. The JWT validator also needs a published `HttpClient`; see
[HTTP authorization](../../http-authorization/#configure-a-resource).

```yaml
- name: "@graftland/plugin-http/oauth/jwt"
  config:
    issuer: https://auth.example.com
    audience: https://mcp.example.com/mcp
    jwksUrl: https://auth.example.com/jwks
- name: "@graftland/plugin-http/oauth"
  config:
    resource: https://mcp.example.com/mcp
    authorizationServers: [https://auth.example.com]
- name: "@graftland/plugin-mcp-server/http"
  config:
    path: /mcp
    authorization: { scopes: ["notes:read"] }
```

| State                                  | Result                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `Authorization` missing or withdrawn   | The protected path returns 404                                                     |
| Authorization available, token missing | 401 with `WWW-Authenticate` and protected resource metadata                        |
| Required scope missing                 | 403 `insufficient_scope`                                                           |
| Valid token                            | `Principal` reaches tool handlers and overrides a same-key plugin service          |
| OAuth plugins load or unload           | Unprotected transports keep their activation                                       |
| Listener port changes                  | MCP routes keep their activation                                                   |
| Legacy session DELETE                  | 204; later session requests return 404. Protected endpoints enforce authorization. |

## Configure the core

| Field                                                | Default                            | Rule                                                             |
| ---------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `name`, `version`                                    | `graft`, `0.0.0`                   | Server identity                                                  |
| `description`, `websiteUrl`, `icons`, `instructions` | Absent                             | Effect server metadata                                           |
| `protocols`                                          | Every Effect adapter, newest first | Includes `2026-07-28` and `2025-11-25`; must be nonempty         |
| `cache`                                              | Absent                             | `discover`, `tools`, `resources`, `resourceTemplates`, `prompts` |
| `cache.<list>.ttl`                                   | Required when configured           | Nonnegative milliseconds; accepts a number or numeric string     |
| `cache.<list>.cacheScope`                            | `private`                          | Only `private` is supported                                      |

`resources/read` always has a private cache hint with zero lifetime. Lists
return all entries without pagination. Tools, resources and prompts remain
advertised even when their lists are empty.

## Lifetimes

| Change                              | Result                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Contributor loads, reloads or stops | Lists change; the next call uses the live handler                        |
| Contributor stops                   | Its running calls are interrupted and awaited                            |
| Two offers conflict in one list     | All conflicting offers are hidden; each transport logs `Conflict`        |
| One offer fails to install          | That item stays hidden; other items remain available                     |
| Core configuration changes          | Every transport restarts; clients reconnect; contributors keep running   |
| A transport changes or stops        | Only that transport restarts or stops                                    |
| Extension declarations change       | A warning is logged; the change applies at the transport's next start    |
| stdin ends                          | In-flight work finishes, then `Application.finish` stops the application |

Cancelling an open `subscriptions/listen` lets stdio drain before EOF. Reloading
the core or transport never finishes the application. Under `graft start`,
`Application.claimProtocol` owns stdio exclusivity. Outside it, the embedder
decides who reads stdio. Run at most one stdio transport per process.

## Isolate servers

Isolate these seven keys together on a group containing its core, transports and
contributors. Each key has the prefix `@graftland/plugin-mcp-server/`.

| Key suffix              | Kind      | Use                                      |
| ----------------------- | --------- | ---------------------------------------- |
| `Server/Server`         | Service   | One core per realm                       |
| `Catalog/Offered`       | Event     | Pull the live offers                     |
| `Catalog/Changed`       | Event     | Await every projection's synchronization |
| `Resources/Updated`     | Event     | Notify resource subscribers              |
| `Middleware/Middleware` | Waterfall | Call policy                              |
| `Middleware/Visible`    | Event     | Per-request visibility                   |
| `Extensions/Declared`   | Event     | Snapshot extension declarations          |

```ts
import { Array } from "effect"

import { isolate } from "@graftland/plugin-mcp-server/Server"

export const serverIsolation = {
	isolate: Array.map(isolate, (key) => ({ key })),
}
```

In YAML, map each full key to `true` under the group's `isolate`. Reuse that
mapping with an anchor for a second group. List a contributor in both groups to
serve it on both servers. Omitting a key shares it; omitting `Middleware` or
`Visible` shares those policies. Two cores in the same realm fail with
`ServiceConflict`.

The core, transports and contributors run in one process. Do not place them
under Remote: `Server` carries Effect layers.

Both groups can share one listener. Leave the HTTP routing keys shared; isolate
all seven MCP keys together:

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: public
  id: public
  group: true
  isolate: &mcp
    "@graftland/plugin-mcp-server/Server/Server": true
    "@graftland/plugin-mcp-server/Catalog/Offered": true
    "@graftland/plugin-mcp-server/Catalog/Changed": true
    "@graftland/plugin-mcp-server/Resources/Updated": true
    "@graftland/plugin-mcp-server/Middleware/Middleware": true
    "@graftland/plugin-mcp-server/Middleware/Visible": true
    "@graftland/plugin-mcp-server/Extensions/Declared": true
  config:
    - name: "@graftland/plugin-mcp-server"
      config: { name: notes-public }
    - name: "@graftland/plugin-mcp-server/http"
      config: { path: /mcp }
    - name: ./plugins/search.ts
- name: admin
  id: admin
  group: true
  isolate: *mcp
  config:
    - name: "@graftland/plugin-mcp-server"
      config: { name: notes-admin }
    - name: "@graftland/plugin-mcp-server/http"
      config: { path: /admin/mcp }
    - name: ./plugins/search.ts
    - name: ./plugins/admin.ts
```
