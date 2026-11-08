---
title: Remote 契約
description: 定義有版本的操作，並將協定與實作分開。
---

**契約**描述單元之間共用的協定。在[單元目標](../../units/)中選擇已擷取程式碼，用[繫結](../../bindings/)連接服務。

## 定義契約

用 `Contract.service` 描述每個跨越邊界的服務：它的鍵、列出各個呼叫的 Effect
`RpcGroup`，以及兩個函式。

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

`toHandlers` 在實作服務的一側執行，`fromClient` 在使用服務的一側執行。請在
`fromClient` 中轉換
`RpcClientError`，讓連線中斷以呼叫端本來就會處理的錯誤出現。`Contract.make`
再把這些描述彙整成契約：

| 欄位 | 意義 | |
---------- 建構函式只收集純宣告。Describe 在准入前驗證服務鍵、操作識別和一元呼叫形式。

- | ------------------------------------------------ | | `name` | 外掛名稱。 | |
  `config` | 設定 schema，必須能編碼為 JSON。 | | `error`
  | 外掛宣告的失敗的 schema，預設為 `Schema.Never`。 | | `inject`
  | 實作使用的宿主服務。 | | `provides` | 實作發布給宿主的服務。 |

- 契約中的 schema 都不能需要服務才能編碼或解碼。
- 服務鍵在同一份契約內必須唯一；RPC 名稱可以在不同服務間重複。
- 以 `contract` 或預設匯出的形式匯出契約。
- 雙方匯入同一份建置後的契約，所以鍵與 RPC schema 一致。

## 操作識別

服務中的每個 RPC 都透過 `Contract.operation` 取得不可變的 `name@version` 識別。

| 規則         | 意義                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 名稱與版本   | 名稱不得為空或含空白，版本必須是正整數。                                                                                    |
| 協定變更     | schema、編碼或語意改變時，提升該操作的版本。                                                                                |
| 傳輸標籤     | Effect RPC 的標籤保持不變，它不是操作識別。                                                                                 |
| 服務中繼資料 | `service.operations` 列出 RPC 群組中的操作識別。缺少識別或同一服務內識別重複會被拒絕。                                      |
| 相容性       | `Contract.compareOperations(required, provided)` 檢查精確的集合包含關係。提供方可以有額外操作；新版本不能滿足舊版本的要求。 |

比較是純粹的中繼資料檢查，不比較 schema，也不檢查執行中的實作。套件版本與摘要屬於部署資訊，不決定操作相容性。

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

## 宣告實作

在 `Plugin.make({ provides })` 中宣告服務描述，再在 `apply` 中用 `Graft.provide`
發布服務值。`overlap: true` 宣告服務可以安全地與另一次服務嘗試並行執行，預設為
`false`。核心 Overlap 要求此宣告；嵌入式重啟仍採用協作式生命週期。

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

通知是事實，沒有業務結果。`Notifications`
用同一個契約服務裡的兩個一般一元操作傳遞通知，因此綁定、預算與呼叫證據都與其他呼叫相同。

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

發出方提供 `Notifications.emitter()` 回傳的通道並呼叫
`publish`。訂閱方注入通道，把 `Notifications.subscribe(channel, handle)`
fork 到自己的 scope 中。

| 規則     | 含義                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 確認     | 訂閱方逐條拉取通知；`handle` 完成後，下一次拉取才確認上一條。                               |
| 順序     | 只在同一發出方與同一訂閱方的存活會話內保證。會話從下一條發布的通知開始。                    |
| 結果未知 | 沒有確認的投遞以 `Lost` 回傳，不再重送。之後的通知等它結算後才投遞。                        |
| 有界佇列 | 每個會話最多保留 `capacity` 條（預設 256）；溢出時丟棄最早的通知，並以 `Dropped` 回報數量。 |
| 閒置會話 | 超過 12 個等待時長沒有拉取的會話會被丟棄。                                                  |

投遞語義為至多一次，並明確回報結果。跨重啟的重播與去重由領域協定負責。

## 投影契約操作

[MCP 投影](../../mcp-server/projection/)透過注入的服務公開明確註解的操作。`Contract.identity(rpc)`
讀取操作身分，不解釋 schema。MCP JSON
Schema 只描述工具輸入，絕不參與來源紀錄或相容性。
