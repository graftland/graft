---
title: Node 进程
description: 通过子进程的 stdio 或 worker 线程提供服务并连接。
---

`node` 入口提供 `effect/rpc` 的 Protocol，用来在子进程或 `worker_threads`
worker 中运行服务。它是一层薄封装：启动与关闭进程，以及在 stdio 或 worker 通道上做分帧。

## 契约

两个进程导入同一个契约。

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

## 子进程

```ts
import { Schedule } from "effect"

import { subprocessProtocol } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const client = Remote.connect({
	services: [pricing],
	protocol: subprocessProtocol({
		entry: "dist/worker.js",
		args: ["--mode", "pricing"],
	}),
	retry: Schedule.exponential("200 millis"),
})
```

| 选项       | 含义                                                        |
| ---------- | ----------------------------------------------------------- |
| `entry`    | 子程序的路径。                                              |
| `args`     | `entry` 之后的附加参数。                                    |
| `execPath` | Node 可执行文件；默认为当前这个。                           |
| `cwd`      | 子进程的工作目录。                                          |
| `env`      | 环境变量；默认继承。                                        |
| `stderr`   | `"inherit"`（默认）或 `"ignore"`；诊断信息不能占用 stdout。 |

子进程在自己的标准输入和输出上使用带长度前缀的 RPC。启动发生在当前 scope 里，关闭 scope 会杀掉子进程。退出的子进程会结束连接，看起来与任何其他断线一样。

## Worker 线程

```ts
import { Schedule } from "effect"

import { workerProtocol } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const client = Remote.connect({
	services: [pricing],
	protocol: workerProtocol({ entry: new URL("./worker.js", import.meta.url) }),
	retry: Schedule.exponential("200 millis"),
})
```

worker 使用自己的
`MessagePort`，不涉及 stdio。worker 在当前 scope 里启动，scope 关闭时终止；worker 退出同样会结束连接。

## 在另一端提供服务

在子进程或 worker 里正常构建图，并通过对应的 Protocol 提供服务：

```ts
import { layerProtocolStdio } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const server = Remote.serve({
	services: [pricing],
	protocol: layerProtocolStdio,
})
```

| 服务端在哪里运行 | Protocol              |
| ---------------- | --------------------- |
| 子进程           | `layerProtocolStdio`  |
| Worker 线程      | `layerProtocolWorker` |

子进程或 worker 拥有自己的生命周期；父级关闭管道时，它的读取随之结束。

## 选择传输方式

| 需求                 | 使用                     |
| -------------------- | ------------------------ |
| 强隔离、独立内存     | 通过 stdio 的子进程      |
| 低开销并发、共享内存 | Worker 线程              |
| 另一台机器           | socket 或 WebSocket 协议 |

`node`
不添加自己的抽象，只提供 Protocol 层。契约、`Remote.serve`、`Remote.connect`
和重连都与[远程服务](../remote/)相同。这个入口需要
`@effect/platform-node`，它是可选的 peer 依赖，并且只在 Node.js 上运行。
