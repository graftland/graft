# @graftland/plugin-mcp-server

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

通过普通 Graft 插件提供工具、资源和提示词。贡献插件重载时客户端无需重新连接。核心发布
`Server`，同级传输消费它。

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

请在直接嵌入的应用中运行；`graft start --stdio`
会被拒绝，因为插件运行在单元里，没有插件拥有进程的标准输入输出。Effect 处理 MCP
2026-07-28 和旧版 2025-11-25 客户端。

## HTTP

Streamable HTTP 传输。

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: "@graftland/plugin-mcp-server"
- name: "@graftland/plugin-mcp-server/http"
- name: ./src/echo.ts
```

## 文档

- [MCP server](https://graftland.github.io/graft/mcp-server/overview/)
- [Contributions and limits](https://graftland.github.io/graft/mcp-server/contributing/)
- [Extension points](https://graftland.github.io/graft/mcp-server/extending/)
- [Sample](../../samples/mcp-tools/)

[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
