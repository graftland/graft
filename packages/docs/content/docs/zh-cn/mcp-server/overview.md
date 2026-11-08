---
title: MCP 服务器
description: 用核心、传输和贡献插件组成 MCP 服务器。
---

`@graftland/plugin-mcp-server`
通过 Effect 的 MCP 服务器提供工具、资源和提示词。**核心**发布
`Server`，同级传输插件消费它。贡献插件加载或卸载时，客户端无需重新连接。

## 运行 stdio

```yaml
- name: "@graftland/plugin-mcp-server"
  config: { name: notes, version: 1.0.0 }
- name: "@graftland/plugin-mcp-server/stdio"
- name: ./plugins/notes.ts
```

运行 `graft start --stdio`。使用 `Effect.log*`
记录日志；stdout 属于协议，由内核[借给这个单元](../../cli/#协议输出)。[示例](https://github.com/graftland/graft/tree/main/samples/mcp-tools)包含可运行的客户端配置。

| 条目                                 | 短名称             | 职责                        |
| ------------------------------------ | ------------------ | --------------------------- |
| `@graftland/plugin-mcp-server`       | `mcp-server`       | 发布服务器选项              |
| `@graftland/plugin-mcp-server/stdio` | `mcp-server/stdio` | 运行 Effect 的 stdio 服务器 |
| `@graftland/plugin-mcp-server/http`  | `mcp-server/http`  | 挂载 Streamable HTTP 路由   |

## 提供 HTTP

将共享的 [HTTP 路由器和监听器](../../http/)与核心放在一起，并以一个长期运行的
`graft start`
运行这份配置。stdio 放在单独的配置中：MCP 客户端每个会话启动一个 stdio 进程，固定端口会冲突。两份配置可以列出相同的贡献插件。

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

| 字段                   | 默认值 | 规则                                                      |
| ---------------------- | ------ | --------------------------------------------------------- |
| `path`                 | `/mcp` | 共享路由器上的端点                                        |
| `allowedOrigins`       | 无     | 拒绝未明确列出的 `Origin`；没有该请求头的请求仍可访问     |
| `authorization.scopes` | 无     | 配置后要求共享的 `Authorization` 服务及全部列出的权限范围 |

### 要求授权

用下面的受保护条目替换上面的 HTTP 条目，并添加 OAuth 插件。JWT 验证器还需要已发布的
`HttpClient`；见 [HTTP 授权](../../http-authorization/)。

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

| 状态                       | 结果                                                     |
| -------------------------- | -------------------------------------------------------- |
| `Authorization` 缺失或撤回 | 受保护路径返回 404                                       |
| 授权可用，但缺少令牌       | 401，带 `WWW-Authenticate` 和受保护资源元数据            |
| 缺少要求的权限范围         | 403 `insufficient_scope`                                 |
| 令牌有效                   | `Principal` 到达工具处理函数，并覆盖插件中的同键服务     |
| OAuth 插件加载或卸载       | 未保护的传输保持当前激活                                 |
| 监听器端口改变             | MCP 路由保持当前激活                                     |
| 旧版会话 DELETE            | 返回 204，之后访问该会话返回 404。受保护端点仍检查授权。 |

## 配置核心

| 字段                                                 | 默认值                       | 规则                                                             |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `name`, `version`                                    | `graft`, `0.0.0`             | 服务器身份                                                       |
| `description`, `websiteUrl`, `icons`, `instructions` | 无                           | Effect 服务器元数据                                              |
| `protocols`                                          | 全部 Effect 适配器，最新优先 | 包含 `2026-07-28` 和 `2025-11-25`；不能为空                      |
| `cache`                                              | 无                           | `discover`, `tools`, `resources`, `resourceTemplates`, `prompts` |
| `cache.<list>.ttl`                                   | 配置时必填                   | 非负毫秒数；接受数字或数字字符串                                 |
| `cache.<list>.cacheScope`                            | `private`                    | 仅支持 `private`                                                 |

`resources/read`
的缓存提示始终为私有，存活时间为零。列表返回全部条目，不分页。工具、资源和提示词即使列表为空，也始终声明为可用能力。

## 生命周期

| 变化                     | 结果                                                       |
| ------------------------ | ---------------------------------------------------------- |
| 贡献插件加载、重载或停止 | 列表改变；下次调用使用当前处理函数                         |
| 贡献插件停止             | 中断其正在运行的调用并等待结束                             |
| 同一列表中的两个贡献冲突 | 隐藏所有冲突贡献；每个传输记录 `Conflict`                  |
| 一个贡献注册失败         | 该项保持隐藏；其他项仍然可用                               |
| 核心配置改变             | 所有传输重启；客户端重新连接；贡献插件继续运行             |
| 一个传输改变或停止       | 仅重启或停止该传输                                         |
| 扩展声明改变             | 记录警告；该传输下次启动时生效                             |
| stdin 结束               | 等待正在运行的工作结束，再由 `Application.finish` 停止应用 |

取消尚未结束的
`subscriptions/listen`，stdio 才能在 EOF 后排空。重载核心或传输不会结束应用。在
`graft start` 下，`Application.claimProtocol`
保证 stdio 独占。嵌入时，由嵌入方决定谁读取 stdio。每个进程最多运行一个 stdio 传输。

## 隔离服务器

在包含核心、传输和贡献插件的组上，一起隔离以下七个键。所有键都带有
`@graftland/plugin-mcp-server/` 前缀。

| 键后缀                  | 类型   | 用途             |
| ----------------------- | ------ | ---------------- |
| `Server/Server`         | 服务   | 每个领域一个核心 |
| `Catalog/Offered`       | 事件   | 拉取当前贡献     |
| `Catalog/Changed`       | 事件   | 等待每个投影同步 |
| `Resources/Updated`     | 事件   | 通知资源订阅者   |
| `Middleware/Middleware` | 瀑布流 | 调用策略         |
| `Middleware/Visible`    | 事件   | 按请求判断可见性 |
| `Extensions/Declared`   | 事件   | 获取扩展声明快照 |

```ts
import { Array } from "effect"

import { isolate } from "@graftland/plugin-mcp-server/Server"

export const serverIsolation = {
	isolate: Array.map(isolate, (key) => ({ key })),
}
```

在 YAML 中，在组的 `isolate` 下将每个完整键映射到
`true`。第二个组可以用锚点复用该映射。要向两个服务器提供同一个贡献插件，在两个组中都列出它。省略某个键就会共享它；省略
`Middleware` 或 `Visible` 就会共享对应策略。同一领域中的第二个核心会报
`ServiceConflict`。

核心、传输和贡献插件必须运行在同一个进程中。不要放在 Remote 下：`Server`
携带 Effect 层。

两个组可以共用一个监听器。保留共享的 HTTP 路由键，将七个 MCP 键一起隔离：

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
