---
title: MCP 贡献
description: 提供由插件拥有生命周期的工具、资源和提示词。
---

**贡献**属于一个插件。处理函数使用该插件的服务、领域和日志注解。请求服务和中间件添加的服务如果与传输的基础上下文不同，就具有更高优先级。

## 提供工具

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

用 `inject` 声明插件所需的服务，并通过 Effect 的 `Tool`
声明工具依赖。`Tools.plugin` 拒绝未声明的服务需求。在现有插件中使用
`Tools.offer(toolkit, handlers)`。名称冲突会隐藏整个工具集，包括其中没有重名的工具。

## 提供资源和提示词

```ts
import { Effect, Schema } from "effect"
import { McpSchema } from "effect/ai"

import { Plugin } from "@graftland/graft"
import * as Prompts from "@graftland/plugin-mcp-server/Prompts"
import * as Resources from "@graftland/plugin-mcp-server/Resources"

export default Plugin.make({
	name: "@acme/graft-plugin-notes",
	apply: () =>
		Effect.gen(function* () {
			yield* Resources.offer({
				name: "Notes",
				uri: "notes://index",
				content: Effect.succeed("One note"),
			})
			const greeting =
				yield* Resources.template`greeting://${McpSchema.param("name", Schema.String)}`(
					{
						name: "Greeting",
						content: (_uri, name) => Effect.succeed("Hello " + name),
						completion: { name: () => Effect.succeed(["Ada", "Grace"]) },
					},
				)
			yield* Resources.offer(greeting)
			yield* Prompts.offer({
				name: "greet",
				parameters: { name: Schema.String },
				content: ({ name }) => Effect.succeed("Greet " + name),
				completion: { name: () => Effect.succeed(["Ada", "Grace"]) },
			})
		}),
})
```

| 贡献     | 输入                                                | 标识     |
| -------- | --------------------------------------------------- | -------- |
| 静态资源 | Effect `registerResource` 选项                      | URI      |
| 资源模板 | `Resources.template`，使用 Effect schema 和注册选项 | URI 模板 |
| 提示词   | Effect `registerPrompt` 选项，含 `completion`       | 名称     |

资源模板和提示词拥有其补全处理函数的生命周期。撤回静态资源或模板后，不再遮挡仍然可用的重叠模板。`Resources.updated(uri)`
通知其领域中的监听者。在内容改变后调用它；提供资源不会自动监控内容。

## 使用客户端能力

处理函数直接调用 Effect；Graft 不提供 `Client` 包装层。

| 需求                               | Effect 公共 API                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 客户端能力                         | `McpServer.clientCapabilities`                                                                 |
| 请求 `_meta`、进度令牌和 MRTR 输入 | `McpSchema.McpRequestContext`                                                                  |
| 旧版表单征询                       | `McpServer.elicit`                                                                             |
| URL 征询、采样、根目录             | `(yield* (yield* McpSchema.McpServerClient).getClient).elicit`, `.createMessage`, `.listRoots` |
| URL 征询完成通知                   | `(yield* McpServer.McpServer).notifyElicitationComplete`                                       |
| 协议日志和进度                     | `(yield* McpServer.McpServer).notifications`                                                   |
| 底层 MRTR                          | 通过自定义[种类](../extending/)使用 Effect `addTool` 或 `addPrompt`                            |

读取当前请求的
`requestMetadata.progressToken`，旧版请求也适用。只有存在令牌时才发送进度。协议日志与
`Effect.log*`
分开；CLI 下后者写入 stderr。Effect 负责能力协商和各协议版本的消息投递。

## 限制

以下项目未在 Graft 中实现，需要上游 `effect/ai` 或其 RPC 层改动。

| 限制                                     | Effect 边界                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Toolkit 工具图标                         | `registerToolkit` 不传递图标                                                                         |
| Toolkit MRTR                             | Toolkit 处理函数不能返回 `InputRequired`                                                             |
| 资源 MRTR                                | `addResource` 不能返回 `InputRequired`                                                               |
| 密封或一次性 `requestState`              | 状态原样传递，不做完整性保护                                                                         |
| 重载后确定性的列表排序                   | Effect 保留注册顺序                                                                                  |
| 服务器 `title`                           | 服务器选项不接受它                                                                                   |
| 仅现代版本服务器的 `initialize` 错误详情 | 该路径的 `-32022` 没有 `data.supported`                                                              |
| 非法 JSON 的错误标准化                   | stdio 和套接字协议不返回带 `id: null` 的 `-32700`                                                    |
| 自定义传输控制消息和批处理策略           | 内置 RPC 序列化不是公开的 MCP 线协议编解码器                                                         |
| 套接字 EOF 会话清理                      | 套接字协议报告断开，但不生成 `Eof`                                                                   |
| 错误数据净化                             | RPC 错误可能含有 Effect cause                                                                        |
| 跟踪上下文传播                           | 没有 MCP `traceparent`、`tracestate` 或 `baggage` 集成                                               |
| 处理函数触发能力错误                     | 没有用 `-32021` 要求能力的公共辅助函数                                                               |
| 动态扩展能力和自定义方法                 | 声明是快照；没有方法注册入口                                                                         |
| 进度单调性和速率限制                     | 没有公共 MCP 强制检查 API                                                                            |
| 传输关闭时保证返回最终监听结果           | 作用域关闭可能直接断开，不返回最终结果                                                               |
| 补全谓词                                 | Effect 补全查找不执行条目自身的 `EnabledWhen`；卸载仍会撤回补全                                      |
| 旧版 HTTP GET                            | 返回 405；没有独立 SSE 流                                                                            |
| 旧版 HTTP 恢复                           | 未实现事件重放和恢复                                                                                 |
| 旧版 HTTP 通知                           | 仅通过未关闭的 POST 响应流发送                                                                       |
| HTTP 代理缓冲                            | Effect 不发送 `X-Accel-Buffering: no`                                                                |
| HTTP 会话生命周期                        | 没有会话过期机制；未保护端点上重复的 initialize 请求可无限分配会话状态。客户端可用 DELETE 释放会话。 |
| Toolkit `x-mcp-header` 注解              | `registerToolkit` 忽略普通自定义 Schema 注解；底层工具输入 schema 可用                               |

Tasks、MCP Apps、Skills、Server Cards 和 `capabilities.experimental`
不在范围内。Graft 不附带 MCP 扩展实现。
