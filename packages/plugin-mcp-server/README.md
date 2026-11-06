# @graftland/plugin-mcp-server

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Serve tools, resources and prompts through ordinary Graft plugins. Contributors
can reload without reconnecting clients. The core publishes `Server`; sibling
transports consume it.

```ts
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

import * as Tools from "@graftland/plugin-mcp-server/Tools"

const Echo = Toolkit.make(
	Tool.make("echo", {
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
	}),
)

export default Tools.plugin({
	name: "@acme/graft-plugin-echo",
	toolkit: Echo,
	handlers: Effect.succeed(
		Echo.of({ echo: ({ text }) => Effect.succeed(text) }),
	),
})
```

```yaml
- name: "@graftland/plugin-mcp-server"
- name: "@graftland/plugin-mcp-server/stdio"
- name: ./src/echo.ts
```

Run `graft start --stdio --watch`. Effect handles MCP 2026-07-28 and legacy
2025-11-25 clients.

## HTTP

The Streamable HTTP transport.

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: "@graftland/plugin-mcp-server"
- name: "@graftland/plugin-mcp-server/http"
- name: ./src/echo.ts
```

## Documentation

- [MCP server](https://graftland.github.io/graft/mcp-server/overview/)
- [Contributions and limits](https://graftland.github.io/graft/mcp-server/contributing/)
- [Extension points](https://graftland.github.io/graft/mcp-server/extending/)
- [Sample](../../samples/mcp-tools/)

[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
