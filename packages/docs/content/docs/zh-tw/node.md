---
title: Node 行程
description: 透過子行程的 stdio 或 worker 執行緒提供服務並連線。
---

`node` 入口提供 `effect/rpc` 的 Protocol，用來在子行程或 `worker_threads`
worker 中執行服務。它是一層薄封裝：啟動與關閉行程，以及在 stdio 或 worker 通道上做分幀。

## 契約

兩個行程匯入同一個契約。

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

## 子行程

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

| 選項       | 含義                                                        |
| ---------- | ----------------------------------------------------------- |
| `entry`    | 子程式的路徑。                                              |
| `args`     | `entry` 之後的附加引數。                                    |
| `execPath` | Node 執行檔；預設為目前這個。                               |
| `cwd`      | 子行程的工作目錄。                                          |
| `env`      | 環境變數；預設繼承。                                        |
| `stderr`   | `"inherit"`（預設）或 `"ignore"`；診斷訊息不能佔用 stdout。 |

子行程在自己的標準輸入和輸出上使用帶長度前綴的 RPC。啟動發生在目前 scope 裡，關閉 scope 會殺掉子行程。結束的子行程會結束連線，看起來與任何其他斷線一樣。

## Worker 執行緒

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
`MessagePort`，不涉及 stdio。worker 在目前 scope 裡啟動，scope 關閉時終止；worker 結束同樣會結束連線。

## 在另一端提供服務

在子行程或 worker 裡正常建置圖，並透過對應的 Protocol 提供服務：

```ts
import { layerProtocolStdio } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const server = Remote.serve({
	services: [pricing],
	protocol: layerProtocolStdio,
})
```

| 服務端在哪裡執行 | Protocol              |
| ---------------- | --------------------- |
| 子行程           | `layerProtocolStdio`  |
| Worker 執行緒    | `layerProtocolWorker` |

子行程或 worker 擁有自己的生命週期；父層關閉管道時，它的讀取隨之結束。

## 選擇傳輸方式

| 需求                   | 使用                     |
| ---------------------- | ------------------------ |
| 強隔離、獨立記憶體     | 透過 stdio 的子行程      |
| 低開銷並行、共用記憶體 | Worker 執行緒            |
| 另一台機器             | socket 或 WebSocket 協定 |

`node`
不添加自己的抽象，只提供 Protocol 層。契約、`Remote.serve`、`Remote.connect`
和重新連線都與[遠端服務](../remote/)相同。這個入口需要
`@effect/platform-node`，它是可選的 peer 相依項目，並且只在 Node.js 上執行。
