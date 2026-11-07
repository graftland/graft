---
title: HTTP API
description: 用 Effect HttpApi 路由组提供实时 OpenAPI 文档和类型化客户端。
---

`@graftland/plugin-http-api` 把 Effect **HttpApi 路由组**作为普通插件部署到
[共享 HTTP 监听器](../http/)。可选的组合插件发布实时 OpenAPI 文档。

- 不加载组合插件也能提供路由；重启它不影响路由组。
- 加载或卸载路由组会更新文档和文档界面。
- 第三方通过同一套公开 API 贡献路由组、组合文档和提供界面。

## 提供契约

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

| 规则         | 行为                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 选中的路由组 | 提供对应的 `HttpApiBuilder.group` 层；多个组的层可以合并。                                                              |
| 依赖         | 在插件的 `inject` 中声明处理器和中间件需要的服务。                                                                      |
| 前缀         | 在契约上使用 `.prefix`，路由和文档保持一致。                                                                            |
| API 注解     | 组合插件提供文档元数据；来源 API 的标题不会改名路由组标签。保留组和端点的注解。                                         |
| 手动提供路由 | `HttpApis.advertise(groups, mount)` 回答 `Groups`。从 `Context.get(yield* Http.mount(routes), Http.Mounted)` 取得挂载。 |

## 配置文档

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

| 字段                              | 默认值                | 含义                           |
| --------------------------------- | --------------------- | ------------------------------ |
| `title`、`version`、`description` | Effect OpenAPI 默认值 | 文档元数据。                   |
| `servers`                         | 未设置                | `{ url, description? }` 列表。 |
| `openapi`                         | `/openapi.json`       | 路由路径，或 `false`。         |

条目可以省略 `config`，使用全部默认值。

## 共享中间件

在契约中定义 Effect `HttpApiMiddleware.Service` 并附加到组。认证插件用
`Graft.provide` 发布实现；路由组插件在 `inject` 中声明它。

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

| 规则                     | 行为                                     |
| ------------------------ | ---------------------------------------- |
| 同一个中间件中的认证方案 | OR：任一方案可以完成认证。               |
| 叠加的中间件             | AND：每一个都必须成功。                  |
| `.middleware()`          | 仅覆盖调用前加入的端点。                 |
| 提供者卸载               | 路由组进入 `Pending`，路由和文档都消失。 |
| 提供者被替换             | 路由组用新实现重新构建。                 |

把示例令牌换成你的凭证验证服务。

## 冲突

| 冲突                           | 路由服务                                | 文档                                     |
| ------------------------------ | --------------------------------------- | ---------------------------------------- |
| 相同方法和等价路径             | `Http.RouteConflict` 排除所有相关挂载。 | 关联的组被排除，直到冲突解除。           |
| 相同组标识符                   | 不同路径的路由仍可用。                  | `GroupConflict` 排除该标识符下的所有组。 |
| 重复操作 ID 或不兼容的安全方案 | 不同路径的路由仍可用。                  | `GroupConflict` 排除每一对不兼容的组。   |
| 单个组无法生成文档             | 路由仍可用。                            | 排除该组，记录完整 cause。               |
| 整体文档或界面刷新失败         | 路由仍可用。                            | 保留上一次成功的快照，记录完整 cause。   |

## 生命周期

| 变化               | 结果                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| 组加载或卸载       | 路由立即改变，文档和界面随后异步更新。                                           |
| 组合插件重启       | 组保留状态；文档和依赖它的界面重启。                                             |
| 监听器重启         | 挂载、`Http.Routes`、组合插件、`Document` 与界面保留激活状态。                   |
| 卸载时请求还在运行 | 请求被中断，响应头尚未发送时通常返回 503。不可中断的端点会延迟卸载，直到它完成。 |
| Remote 执行        | 路由组和监听器必须在同一进程中运行。                                             |

## 类型化客户端与测试

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

| API                             | 用途                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `HttpApiMiddleware.layerClient` | 创建客户端时提供客户端认证中间件。                                                   |
| `HttpApiTest.groups`            | 不打开套接字，用类型化客户端测试处理器层；提供 `HttpServer.layerServices` 和处理器。 |
| 真实 HTTP 测试                  | 使用 `port: 0` 的监听器和 `HttpApiClient.make`。                                     |

## 扩展组合与界面

| 扩展           | 契约                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 路由组贡献者   | 提供服务期间回答 `HttpApis.Groups`，添加或移除回答后发出 `GroupsChanged`。                                                           |
| 自定义组合插件 | 收集 `HttpApis.Groups`，复用 Effect `HttpApi` 和 `OpenApi`，记录失败 cause，发布 `HttpApis.Document`。变更处理器只通知有归属的任务。 |
| 路由过滤       | 读取组的 `HttpApis.ServingMount` 注解，只保留其挂载存在于 `Http.Routes.served` 的组。手动 `advertise` 未提供挂载时无法过滤。         |
| 自定义界面     | 注入 `HttpApis.Document`，在有归属的任务中跟随 `SubscriptionRef` 快照；保持固定挂载，用 `ScopedRef` 替换其应用。                     |
| 内置界面       | 将 `@graftland/plugin-http-api/scalar` 或 `/swagger` 作为同级条目加载。两者接受 `{ path }`，默认为 `/docs`，资源随包提供。           |

组合插件按组标识符排序，使不同加载顺序下的标签和 schema 组件名保持稳定。同一 schema 的两个独立副本仍可能生成
`User` 和 `User_1` 等名称。

## Realm

一起隔离监听器、贡献事件和文档。`graft.yml` 使用以下键字符串：

| Token                    | 键                                                  |
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
