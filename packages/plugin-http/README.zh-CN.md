# @graftland/plugin-http

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由是普通插件。用 `Http.mount` 挂载 Effect `HttpRouter`
层；卸载插件会移除路由并中断请求与流，监听器继续运行。

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

`port` 必填；`host` 默认为
`127.0.0.1`。不提供服务器级身份验证；使用挂载中间件或反向代理。

参见 [HTTP 指南](https://docs.graft.land/zh-cn/http/)和
[http-gateway 示例](../../samples/http-gateway)。

`Http.Routing`
让同级监听器插件提供路由核心的服务。修改监听器时，挂载、路由状态与文档保留激活状态。监听器作者可以运行
`@graftland/plugin-http/Testing`。

OAuth 使用 `@graftland/plugin-http/oauth`，配置 `resource` 与
`authorizationServers`；挂载注入其 `Authorization`
守卫。`@graftland/plugin-http/oauth/jwt` 接受 `issuer`、`audience` 和
`jwksUrl`，注入 `HttpClient`。第三方插件也可以发布 `TokenValidator`。
