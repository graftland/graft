---
title: HTTP 服务器
description: 把插件路由挂载到共享 HTTP 服务器。
---

`@graftland/plugin-http` 运行一个 HTTP 监听器。**挂载**是一组由插件拥有的 Effect
`HttpRouter` 路由。

- 路由增减时，监听器持续运行。
- 卸载挂载会中断它的请求和响应流。
- 第三方插件与第一方插件使用相同的公开 API。

## 配置

```yaml title="graft.yml"
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config:
    port: 3000
```

| 键     | 默认值      | 含义                                                                       |
| ------ | ----------- | -------------------------------------------------------------------------- |
| `port` | 必填        | 0 到 65535 的整数或仅含十进制数字的字符串，支持 `!env`；0 让系统分配端口。 |
| `host` | `127.0.0.1` | 绑定地址。                                                                 |

配置中使用完整包名。`Http.Server` 提供实际的 `url` 和
`address`；只有需要随服务器重启的插件才注入它。

## 挂载路由

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

使用 `HttpRouter.add`、`addAll` 或 `use`。处理器从 `RouteContext`
读取路径参数。处理器的依赖要列在挂载插件的 `inject` 中。

| API                         | 在挂载中的用途                                             |
| --------------------------- | ---------------------------------------------------------- |
| `HttpRouter.middleware`     | 为路由添加授权或修改响应；把它的 `.layer` 提供给路由。     |
| `HttpRouter.cors`           | 与路由层合并，设置该挂载的预检策略。                       |
| `HttpRouter.provideRequest` | 挂载时构建层，并将服务提供给请求；构建时无法读取当前请求。 |
| `Http.mount`                | 构建层并返回服务；管理请求直至卸载。                       |
| `Http.advertise`            | 发布已有应用；调用者负责资源和请求的生命周期。             |

参见 [API 参考](../reference/plugin-http/http/readme/)和可运行的
[http-gateway 示例](https://github.com/graftland/graft/tree/main/samples/http-gateway)。

## 路由与冲突

| 请求或注册                                    | 结果                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| 没有 HEAD 路由的 `HEAD`                       | 回退到 GET，不返回响应体。                              |
| 方法未匹配，路径只属于一个挂载                | 交给该挂载处理，包括它的 CORS 预检策略。                |
| 方法未匹配，路径属于多个挂载                  | 404。                                                   |
| 未知路径                                      | 空的 404。                                              |
| 同一方法的等价路径，如 `/a/:id` 和 `/a/:name` | 记录 `RouteConflict` 警告，完整排除所有冲突的挂载。     |
| 同一路径上的 `*` 和 GET                       | 冲突。                                                  |
| 通配路由与更具体的路径                        | 两者都可用。                                            |
| 同一 `Http.mount` 内重复注册                  | 挂载插件启动失败。                                      |
| 无效的手动 `Http.advertise` 贡献              | 记录带原始 cause 的 `InvalidMount` 警告，只排除该挂载。 |

移除冲突的挂载后，其余不再冲突的挂载恢复可用。方法未匹配不会自动返回 405；该响应需要挂载自行提供。

## 生命周期

| 变化                 | 结果                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| 监听器修改或替换     | 监听器和注入 `Http.Server` 的插件重启。挂载、`Http.Routes`、组合插件与界面保留激活状态。 |
| 卸载挂载             | 路由先消失，再关闭资源。                                                                 |
| 热替换路由插件       | 旧路由移除，新插件挂载路由；监听器继续运行。                                             |
| 替换回滚             | 旧插件重新启动并挂载路由。                                                               |
| 必需依赖消失         | 卸载挂载，插件进入 `Pending`；激活后路由恢复。                                           |
| 卸载时处理器仍在运行 | 请求被中断；尚未发送响应头时通常返回 503。                                               |
| 响应体已开始流式传输 | 连接被切断；无法再更改状态码。                                                           |
| `Mounts` 事件        | 仅限进程内。路由核心、挂载与监听器位于同一进程。                                         |

## Realm

把每个服务器及其路由放在同一个[隔离边界](../isolation/)中：

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

同一 realm 中的第二个服务器会在发布的服务上冲突。必须隔离五个 HTTP 键；使用 OAuth 时也隔离授权键。

| Token                | `graft.yml` 中的键                                    |
| -------------------- | ----------------------------------------------------- |
| `Http.Server`        | `@graftland/plugin-http/Http/Server`                  |
| `Http.Mounts`        | `@graftland/plugin-http/Http/Mounts`                  |
| `Http.MountsChanged` | `@graftland/plugin-http/Http/MountsChanged`           |
| `Http.Routes`        | `@graftland/plugin-http/Http/Routes`                  |
| `Http.Routing`       | `@graftland/plugin-http/Http/Routing`                 |
| `Authorization`      | `@graftland/plugin-http/Authorization/Authorization`  |
| `Principal`          | `@graftland/plugin-http/Authorization/Principal`      |
| `TokenValidator`     | `@graftland/plugin-http/Authorization/TokenValidator` |

设置 `PORT=0` 以分配可用端口。

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

## 安全

默认只绑定回环地址，不提供服务器级身份验证。对外提供服务时，使用反向代理，并按需为挂载设置
`HttpRouter.middleware`：

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

把示例令牌换成凭证服务。挂载注入守卫；撤回守卫后进入
`Pending`。除非挂载插件主动接受守卫服务，运维者无法用它保护不属于自己的挂载。

## 其他监听器与路由状态

| API                              | 用途                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Http.Routing`                   | 路由核心发布请求 `handle`。同级监听器注入它，用 Effect 的 `HttpServer.serveEffect` 提供服务，再发布 `Http.Server`。 |
| `Http.Routes`                    | 注入 `SubscriptionRef`，观察每次路由同步后的 `{ served, conflicts }`。                                              |
| `@graftland/plugin-http/Testing` | 在提供 Graft 和 HTTP 客户端的隔离测试中运行 `listener(url)`，检查挂载、卸载、冲突和卸载时的 503。                   |

第三方提供 TLS、HTTP/2 等其他监听器。基于 schema 的路由和实时文档见
[HTTP API](../http-api/)。

令牌验证与资源元数据见 [HTTP 授权](../http-authorization/)。
