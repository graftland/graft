---
title: 遠端服務
description: 透過 effect/rpc 從另一個行程或機器發布服務。
---

Graft 的 `rpc` 入口透過任意 `effect/rpc`
協定暴露服務，並把遠端的服務發布進本地圖。使用這些服務的掛載無需改動。

## 定義契約

一個遠端服務把服務鍵、`RpcGroup`，以及兩者之間的對應配在一起。兩端匯入同一個定義。

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

| 欄位         | 內容                                |
| ------------ | ----------------------------------- |
| `toHandlers` | 用服務端的一個服務回答每個 RPC。    |
| `fromClient` | 用 RPC 用戶端建構用戶端一側的服務。 |

RPC 名稱按服務加前綴，所以兩個服務可以使用相同的名稱。

## 提供服務

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

`serve` 在呼叫時的 scope 裡回傳一個
`Mount`。每個服務只在本地圖裡可用時才對外提供；消失的服務會從所有已連線的用戶端撤回。

## 連線伺服器

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

`connect` 同樣回傳一個
`Mount`。連線結束時，所有遠端服務都從本地圖撤回，Protocol 的 scope 關閉，連線依重試排程重建。

## 可用性

1. **連線。** 用戶端開啟 Protocol，並以串流 RPC 呼叫唯一的控制 RPC `Presence`。
2. **推送集合。** 服務端持續推送它此刻能提供的服務集合。
3. **發布或撤回。** 用戶端發布集合裡的每個服務，並撤回離開集合的服務。
4. **斷線。** `Presence`
   結束或失敗時，撤回所有遠端服務，並關閉 Protocol 的 scope。
5. **重新連線。** 重試排程建構新的 Protocol，從第 1 步重新開始。

可用性跟隨圖，而不是傳輸層自己的連線事件，所以同一套規則適用於 socket、HTTP、WebSocket、worker 和 stdio。

### 撤回一個服務

服務端撤回某個服務時，正在執行的處理函式被中斷，它們的資源被釋放。用戶端針對該服務正在進行中的呼叫會以攜帶
`Graft.ServiceWithdrawn`
的 defect 結束，而不是一直懸置。連線中斷的情況不同：進行中的呼叫以
`RemoteUnavailable` 失敗。

## 呼叫方看到的錯誤

| 錯誤                     | 何時產生                                         |
| ------------------------ | ------------------------------------------------ |
| `RemoteUnavailable`      | 連線中斷時，呼叫還在進行。                       |
| `Graft.ServiceWithdrawn` | 服務端在呼叫期間撤回該服務；呼叫以 defect 結束。 |
| 傳輸錯誤                 | Protocol 連線失敗；由重試排程處理。              |

宣告的 RPC 錯誤帶著自己的 schema 跨過連線。服務端的 defect 在用戶端仍然是 defect，因為 Graft 以
`disableFatalDefects: true` 設定服務端。

## Graft 不做什麼

Graft 不傳送程式碼、不安裝相依項目，也不部署另一個行程。你在想要的位置執行服務端，開啟 Protocol，共用契約模組。之後遠端服務就是本地圖裡的一個普通服務。子行程和 worker 見
[Node 行程](../node/)，記憶體協定見[測試](../testing/)。
