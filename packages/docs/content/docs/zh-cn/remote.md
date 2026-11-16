---
title: 远程服务
description: 通过 effect/rpc 从另一个进程或机器发布服务。
---

Graft 的 `rpc` 入口通过任意 `effect/rpc`
协议暴露服务，并把远端的服务发布进本地图。使用这些服务的挂载无需改动。

## 定义契约

一个远程服务把服务键、`RpcGroup`，以及两者之间的映射配在一起。两端导入同一个定义。

```ts title="contract.ts"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

export class Pricing extends Context.Service<
	Pricing,
	{
		readonly quote: (
			sku: string,
		) => Effect.Effect<number, Remote.RemoteUnavailable>
	}
>()("app/Pricing") {}

class Quote extends Rpc.make("Quote", {
	payload: { sku: Schema.String },
	success: Schema.Finite,
	error: Remote.RemoteUnavailable,
}) {}

const PricingRpcs = RpcGroup.make(Quote)

export const pricing = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (service) => ({
		Quote: ({ sku }: { readonly sku: string }) => service.quote(sku),
	}),
	fromClient: (client) => ({
		quote: (sku) =>
			client
				.Quote({ sku })
				.pipe(
					Effect.mapError(() =>
						Remote.RemoteUnavailable.make({ service: "app/Pricing" }),
					),
				),
	}),
})
```

| 字段         | 内容                                |
| ------------ | ----------------------------------- |
| `toHandlers` | 用服务端的一个服务回答每个 RPC。    |
| `fromClient` | 用 RPC 客户端构造客户端一侧的服务。 |

RPC 名称按服务加前缀，所以两个服务可以使用相同的名称。

## 提供服务

```ts
import type { Layer } from "effect"
import type { RpcServer } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

declare const protocol: Layer.Layer<RpcServer.Protocol>

export const server = Remote.serve({
	services: [pricing],
	protocol,
})
```

`serve` 在调用时的 scope 里返回一个
`Mount`。每个服务只在本地图里可用时才对外提供；消失的服务会从所有已连接的客户端撤回。

## 连接服务器

```ts
import { Schedule, type Effect, type Scope } from "effect"
import type { RpcClient } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

declare const protocol: Effect.Effect<
	RpcClient.Protocol["Service"],
	never,
	Scope.Scope
>

export const client = Remote.connect({
	services: [pricing],
	protocol,
	retry: Schedule.exponential("100 millis"),
})
```

`connect` 同样返回一个
`Mount`。连接结束时，所有远程服务都从本地图撤回，Protocol 的 scope 关闭，连接按重试计划重建。

## 可用性

1. **连接。** 客户端打开 Protocol，并以流式 RPC 调用唯一的控制 RPC `Presence`。
2. **推送集合。** 服务端持续推送它此刻能提供的服务集合。
3. **发布或撤回。** 客户端发布集合里的每个服务，并撤回离开集合的服务。
4. **断线。** `Presence`
   结束或失败时，撤回所有远程服务，并关闭 Protocol 的 scope。
5. **重连。** 重试计划构造新的 Protocol，从第 1 步重新开始。

可用性跟随图，而不是传输层自己的连接事件，所以同一套规则适用于 socket、HTTP、WebSocket、worker 和 stdio。

### 撤回一个服务

服务端撤回某个服务时，正在运行的处理器被中断，它们的资源被释放。客户端针对该服务正在进行中的调用会以携带
`Graft.ServiceWithdrawn`
的 defect 结束，而不是一直挂起。连接断开的情况不同：进行中的调用以
`RemoteUnavailable` 失败。

## 调用方看到的错误

| 错误                     | 何时产生                                         |
| ------------------------ | ------------------------------------------------ |
| `RemoteUnavailable`      | 连接断开时，调用还在进行。                       |
| `Graft.ServiceWithdrawn` | 服务端在调用期间撤回该服务；调用以 defect 结束。 |
| 传输错误                 | Protocol 连接失败；由重试计划处理。              |

声明的 RPC 错误带着自己的 schema 跨过连接。服务端的 defect 在客户端仍然是 defect，因为 Graft 以
`disableFatalDefects: true` 配置服务端。

## Graft 不做什么

Graft 不发送代码、不安装依赖，也不部署另一个进程。你在想要的位置运行服务端，打开 Protocol，共享契约模块。之后远程服务就是本地图里的一个普通服务。子进程和 worker 见
[Node 进程](../node/)，内存协议见[测试](../testing/)。
