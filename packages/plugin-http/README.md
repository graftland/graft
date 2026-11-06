# @graftland/plugin-http

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Routes are ordinary plugins. Mount Effect `HttpRouter` layers with `Http.mount`;
unloading the plugin removes its routes and interrupts its requests and streams.
The listener keeps running.

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config:
    port: 3000
```

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

`port` is required; `host` defaults to `127.0.0.1`. There is no server-wide
authentication: use per-mount middleware or a reverse proxy.

See the [HTTP guide](https://graftland.github.io/graft/http/) and
[http-gateway sample](../../samples/http-gateway).

`Http.Routing` lets sibling listener plugins serve the routing core. Changing a
listener leaves mounts, route state and documentation active. Listener authors
can run `@graftland/plugin-http/Testing`.

For OAuth, load `@graftland/plugin-http/oauth` with `resource` and
`authorizationServers`; inject its `Authorization` guard into mounts.
`@graftland/plugin-http/oauth/jwt` accepts `issuer`, `audience` and `jwksUrl`
and injects `HttpClient`. Third-party plugins can publish `TokenValidator`
instead.
