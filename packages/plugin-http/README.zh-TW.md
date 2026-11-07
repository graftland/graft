# @graftland/plugin-http

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由是一般外掛。用 `Http.mount` 掛載 Effect `HttpRouter`
層；卸載外掛會移除路由並中斷請求與串流，監聽器繼續執行。

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

`port` 必填；`host` 預設為
`127.0.0.1`。不提供伺服器級身分驗證；使用掛載中介軟體或反向代理。

參閱 [HTTP 指南](https://docs.graft.land/zh-tw/http/)與
[http-gateway 範例](../../samples/http-gateway)。

`Http.Routing`
讓同層監聽器外掛提供路由核心的服務。修改監聽器時，掛載、路由狀態與文件保留啟用狀態。監聽器作者可以執行
`@graftland/plugin-http/Testing`。

OAuth 使用 `@graftland/plugin-http/oauth`，設定 `resource` 與
`authorizationServers`；掛載注入其 `Authorization`
守衛。`@graftland/plugin-http/oauth/jwt` 接受 `issuer`、`audience` 與
`jwksUrl`，注入 `HttpClient`。第三方外掛也可以發布 `TokenValidator`。
