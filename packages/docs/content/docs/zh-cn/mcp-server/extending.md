---
title: MCP 扩展点
description: 使用公共服务和事件编写传输、种类或中间件。
---

每个传输、贡献和策略都是普通 Graft 插件。辅助函数与公共令牌放在一起：导入时不加载驱动，也不执行 I/O。因此第三方可以使用同一套 API。

## 编写传输

传输注入 `Server`，取得新的选项，并在自己的协议上构建 Effect 服务器。

```ts
import { Effect, Layer } from "effect"
import { McpServer } from "effect/ai"
import { RpcServer } from "effect/rpc"

import { Plugin } from "@graftland/graft"
import { Server } from "@graftland/plugin-mcp-server/Server"

declare const protocol: Layer.Layer<RpcServer.Protocol>

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-transport",
	inject: [Server],
	apply: Effect.fnUntraced(function* () {
		const options = yield* (yield* Server).options
		yield* Layer.build(McpServer.layer(options).pipe(Layer.provide(protocol)))
	}),
})
```

`Server.options`
捕获核心的上下文，每次调用时取得扩展快照。在传输的作用域中构建其
`registrations`。投影、通知和冲突日志就属于该传输。撤回 `Server`
时，Graft 按普通依赖关系停止其消费者。

## 编写种类

**种类**将一个项目映射到 MCP 已有的列表。其键用于标记贡献，不是领域键。

```ts
import { Context, Effect } from "effect"
import { McpSchema, McpServer } from "effect/ai"

import * as Catalog from "@graftland/plugin-mcp-server/Catalog"

type Item = Parameters<McpServer.McpServer["Service"]["addTool"]>[0]

export const kind: Catalog.Kind<Item> = {
	key: "@acme/graft-plugin-proxy/Tools/kind",
	list: "tools",
	identities: (item) => [item.tool.name],
	install: (item, annotations) =>
		McpServer.McpServer.use((server) =>
			server.addTool({
				...item,
				annotations: Catalog.enabledWhen(annotations, item.annotations),
			}),
		),
}

export const offer = Effect.fnUntraced(function* (
	tool: McpSchema.Tool,
	forward: Item["handle"],
) {
	const handle = yield* Catalog.own(forward)
	yield* Catalog.offer(kind, { tool, handle, annotations: Context.empty() })
})
```

| 规则                                                              | 原因                                              |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `install` 只注册，不执行 I/O                                      | 目录事件的发出方会等待每个传输                    |
| 每次注册都传入 `Catalog.enabledWhen(annotations, ownAnnotations)` | 撤回和冲突隐藏旧注册；与项目自身的谓词按 AND 组合 |
| 通过 `completions` 报告补全参数名                                 | 替换后不会暴露已撤回的补全处理函数                |
| 用 `Catalog.own` 包装处理函数                                     | 取消时中断并等待贡献插件生命周期内的工作          |
| 同一列表内的标识跨种类唯一                                        | 自定义种类与内置种类没有特权差异                  |
| 用 `Catalog.advertise` 发布准备好的贡献                           | 回答 `Offered`，启动时和撤回后发出 `Changed`      |

种类可以组合工具、资源和提示词。增加 JSON-RPC 方法需要上游 Effect API。

目录变更的派发者等待每个传输同步完成。取消派发者后，同步仍归传输所有；卸载传输会中断收集、安装和通知发送。在收集或安装过程中派发
`Changed` 会合并安排后续同步，不会等待自身。

## 编写中间件

```ts
import { Effect, Ref } from "effect"
import { McpSchema } from "effect/ai"

import { Event, Plugin } from "@graftland/graft"
import * as Middleware from "@graftland/plugin-mcp-server/Middleware"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-call-budget",
	apply: () =>
		Effect.gen(function* () {
			const remaining = yield* Ref.make(100)
			yield* Event.on(
				Middleware.Middleware,
				(call, next) =>
					Effect.gen(function* () {
						if (
							call.method === "tools/call" &&
							(yield* Ref.updateAndGet(remaining, (n) => n - 1)) < 0
						) {
							return yield* Effect.fail(
								McpSchema.McpErrorBase.make({
									code: -32000,
									message: "Call budget exhausted",
								}),
							)
						}
						return yield* next(call)
					}),
				{ order: -10 },
			)
		}),
})
```

较小的 `order` 先运行，位于最外层。相同顺序按注册先后排列，`prepend`
优先。若重载前后相对顺序必须稳定，使用不同的 `order`。`{ global: true }`
可到达所有领域。

| 钩子            | 行为                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `Middleware`    | 包装 Effect 的 `MiddlewareMethod` 调用，不包含列表、initialize、discover 或 listen |
| `Visible`       | 所有处理函数都必须返回 true；失败会使请求失败                                      |
| `call.services` | 请求上下文；在 `next` 前用 `Context.add` 添加服务                                  |
| 中间件卸载      | 在 `next` 前后卸载都会中断正在运行的处理函数；领取前被移除的处理函数会被跳过       |

可见性检查先于中间件，无法看到中间件添加的服务。实现按用户过滤的列表时，从
`call.services`
读取传输提供的请求身份。中间件处理函数使用自己的插件服务。自定义 MCP 错误码必须在
`-32000..-32019` 内。

HTTP 使用 `@graftland/plugin-http/Authorization` 中的
`Principal`。经过验证的请求值也会到达受生命周期管理的工具处理函数，并覆盖插件中的同键服务。

## 声明扩展

```ts
import { Plugin } from "@graftland/graft"
import { declare as declareExtensions } from "@graftland/plugin-mcp-server/Extensions"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-declaration",
	apply: () => declareExtensions({ "com.acme/notes": { version: "1" } }),
})
```

相同声明会合并；同一个键的不等声明会隐藏该键。冲突和声明失败在每个传输中每次观察到新状态时只记录一次。传输保留启动时的快照，直到重启。请求和结果的
`_meta`、注册注解和可见性仍然使用 Effect 的公共扩展点。

## 测试

`Testing.transport` 创建内存传输插件和原始 JSON-RPC 连接，将它与核心并列加载。
`Testing.transportConformance`
检查发现结果中的身份、配置的协议、贡献工具、列表变化、资源订阅 ID、取消和连接关闭。
`Testing.kindConformance` 检查生命周期、冲突、存活谓词和部分注册失败。

| 测试 | 参数                                                      | 用途                                                                            |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 传输 | `expected.name`、`expected.version`、`expected.protocols` | 必填：传输所提供选项的期望值                                                    |
| 传输 | `expected.close`                                          | 核心 fork 的卸载 effect，验证撤回会断开客户端；另一次运行中省略它以检查输入关闭 |
| 传输 | `expected.closeTimeout`                                   | 关闭等待时限，默认为五秒；超时使测试失败，并说明连接未关闭                      |
| 种类 | `ownDisabled`                                             | 可选：带有自身 false 谓词的项目                                                 |
| 种类 | `changed`                                                 | 可选：读取通知的 effect，检查每次列表变更                                       |

分别提供和省略 `close`
各运行一次传输测试，以检查依赖撤回和输入关闭。协议层[限制](../contributing/#限制)仍由 Effect 负责。完整类型见自动生成的
[API 参考](../../reference/plugin-mcp-server/readme/)。
