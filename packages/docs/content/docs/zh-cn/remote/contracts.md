---
title: Remote 契约
description: 定义带版本的操作，并将协议与实现分开。
---

**契约**描述单元之间共享的协议。在[单元目标](../../units/)中选择已捕获代码，用[绑定](../../bindings/)连接服务。

## 定义契约

用 `Contract.service` 描述每个跨越边界的服务：它的键、列出其调用的 Effect
`RpcGroup`，以及两个函数。

```ts title="src/contract.ts"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("app/Greeter") {}

const api = RpcGroup.make(
	Contract.operation(
		"@app/greeter/Greet",
		1,
		Rpc.make("Greet", {
			payload: { name: Schema.String },
			success: Schema.String,
			error: GreetingUnavailable,
		}),
	),
)

const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client
				.Greet({ name })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						GreetingUnavailable.make({ cause }),
					),
				),
	}),
})

export const contract = Contract.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	provides: [greeter],
})
```

`toHandlers` 在服务实现的一侧运行，`fromClient` 在使用服务的一侧运行。在
`fromClient` 中映射
`RpcClientError`，连接断开时调用方看到的就是他们本来就会处理的错误。`Contract.make`
再把这些描述汇总成契约：

| 字段 | 含义 | |
---------- 构造函数只收集纯声明。Describe 在准入前校验服务键、操作标识和一元调用形态。

- | ---------------------------------------------- | | `name` | 插件名。 | |
  `config` | 配置 schema，必须能编码为 JSON。 | | `error`
  | 插件声明的失败的 schema，默认 `Schema.Never`。 | | `inject`
  | 实现要使用的宿主服务。 | | `provides` | 实现发布给宿主的服务。 |

- 契约中的任何 schema 都不能依赖服务来编码或解码。
- 服务键在一个契约内唯一；RPC 名称可以在不同服务之间重复。
- 以 `contract` 或默认导出的形式导出契约。
- 双方导入同一份构建后的契约，所以键和 RPC schema 一致。

## 操作标识

服务中的每个 RPC 都通过 `Contract.operation` 获得不可变的 `name@version` 标识。

| 规则       | 含义                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 名称与版本 | 名称不能为空或含空白，版本必须是正整数。                                                                                    |
| 协议变更   | schema、编码或语义改变时，提升该操作的版本。                                                                                |
| 线上标签   | Effect RPC 的标签保持不变，它不是操作标识。                                                                                 |
| 服务元数据 | `service.operations` 列出 RPC 组中的操作标识。缺少标识或同一服务内标识重复会被拒绝。                                        |
| 兼容性     | `Contract.compareOperations(required, provided)` 检查精确的集合包含关系。提供方可以有额外操作；新版本不能满足旧版本的要求。 |

比较是纯粹的元数据检查，不比较 schema，也不检查运行中的实现。包版本和摘要属于部署信息，不决定操作兼容性。

```ts import.meta.vitest name="contracts: compare operations"
import { Array } from "effect"

import { Contract } from "@graftland/plugin-remote"

import { contract } from "./src/contract.ts"

const required = Array.flatMap(
	contract.provides,
	(service) => service.operations,
)
Contract.compareOperations(required, required) // => ({ _tag: "Compatible" })
Contract.compareOperations(required, []) // => ({ _tag: "Incompatible", missing: [{ name: "@app/greeter/Greet", version: 1 }] })
```

## 声明实现

在 `Plugin.make({ provides })` 中声明服务描述，再在 `apply` 中用 `Graft.provide`
发布服务值。`overlap: true` 声明服务可以安全地与另一次服务尝试并行运行，默认值为
`false`。内核 Overlap 要求此声明；嵌入式重启仍采用协作式生命周期。

```ts title="src/greeter.ts"
import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { contract, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "app/greeter",
	config: contract.config,
	provides: contract.provides,
	overlap: true,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

## 通知

通知是事实，没有业务结果。`Notifications`
用同一个契约服务里的两个普通一元操作传递通知，因此绑定、预算与调用证据都与其他调用相同。

```ts
import { Context, Schema } from "effect"

import { Notifications } from "@graftland/plugin-remote"

export class OrderPlaced extends Context.Service<
	OrderPlaced,
	Notifications.Channel<string>
>()("app/OrderPlaced") {}

export const orderPlaced = Notifications.service(
	OrderPlaced,
	"@app/orders/placed",
	Schema.String,
)
```

发出方提供 `Notifications.emitter()` 返回的通道并调用
`publish`。订阅方注入通道，把 `Notifications.subscribe(channel, handle)`
fork 到自己的 scope 中。

| 规则     | 含义                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 确认     | 订阅方逐条拉取通知；`handle` 完成后，下一次拉取才确认上一条。                               |
| 顺序     | 只在同一发出方与同一订阅方的存活会话内保证。会话从下一条发布的通知开始。                    |
| 结果未知 | 没有确认的投递以 `Lost` 返回，不再重发。之后的通知等它结算后才投递。                        |
| 有界队列 | 每个会话最多保留 `capacity` 条（默认 256）；溢出时丢弃最早的通知，并以 `Dropped` 报告数量。 |
| 空闲会话 | 超过 12 个等待时长没有拉取的会话会被丢弃。                                                  |

投递语义为至多一次，并显式报告结果。跨重启的重放与去重由领域协议负责。

## 投影契约操作

[MCP 投影](../../mcp-server/projection/)通过注入的服务公开显式注解的操作。`Contract.identity(rpc)`
读取操作身份，不解释 schema。MCP JSON
Schema 只描述工具输入，绝不参与来源记录或兼容性。
