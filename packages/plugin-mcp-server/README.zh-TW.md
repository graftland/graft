# @graftland/plugin-mcp-server

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

透過普通 Graft 外掛提供工具、資源和提示詞。貢獻外掛重載時用戶端無需重新連線。核心發布
`Server`，同級傳輸消費它。

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

執行 `graft start --stdio --watch`。Effect 處理 MCP
2026-07-28 和舊版 2025-11-25 用戶端。

## HTTP

Streamable HTTP 傳輸。

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: "@graftland/plugin-mcp-server"
- name: "@graftland/plugin-mcp-server/http"
- name: ./src/echo.ts
```

## 文件

- [MCP server](https://docs.graft.land/mcp-server/overview/)
- [Contributions and limits](https://docs.graft.land/mcp-server/contributing/)
- [Extension points](https://docs.graft.land/mcp-server/extending/)
- [Sample](../../samples/mcp-tools/)

[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
