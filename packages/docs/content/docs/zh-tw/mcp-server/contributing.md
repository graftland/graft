---
title: MCP 貢獻
description: 提供由外掛擁有生命週期的工具、資源和提示詞。
---

**貢獻**屬於一個外掛。處理函式使用該外掛的服務、領域和日誌註解。請求服務和中介軟體新增的服務如果與傳輸的基礎 context 不同，就具有更高優先順序。

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

用 `inject` 宣告外掛所需的服務，並透過 Effect 的 `Tool`
宣告工具依賴。`Tools.plugin` 拒絕未宣告的服務需求。在現有外掛中使用
`Tools.offer(toolkit, handlers)`。名稱衝突會隱藏整個工具集，包括其中沒有重名的工具。

## 提供資源和提示詞

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

| 貢獻     | 輸入                                                | 識別     |
| -------- | --------------------------------------------------- | -------- |
| 靜態資源 | Effect `registerResource` 選項                      | URI      |
| 資源模板 | `Resources.template`，使用 Effect schema 和註冊選項 | URI 模板 |
| 提示詞   | Effect `registerPrompt` 選項，含 `completion`       | 名稱     |

資源模板和提示詞擁有其補全處理函式的生命週期。撤回靜態資源或模板後，不再遮擋仍然可用的重疊模板。`Resources.updated(uri)`
通知其領域中的監聽者。在內容改變後呼叫它；提供資源不會自動監控內容。

## 使用用戶端能力

處理函式直接呼叫 Effect；Graft 不提供 `Client` 包裝層。

| 需求                               | Effect 公開 API                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 用戶端能力                         | `McpServer.clientCapabilities`                                                                 |
| 請求 `_meta`、進度權杖和 MRTR 輸入 | `McpSchema.McpRequestContext`                                                                  |
| 舊版表單徵詢                       | `McpServer.elicit`                                                                             |
| URL 徵詢、取樣、根目錄             | `(yield* (yield* McpSchema.McpServerClient).getClient).elicit`, `.createMessage`, `.listRoots` |
| URL 徵詢完成通知                   | `(yield* McpServer.McpServer).notifyElicitationComplete`                                       |
| 協定日誌和進度                     | `(yield* McpServer.McpServer).notifications`                                                   |
| 底層 MRTR                          | 透過自訂[種類](../extending/)使用 Effect `addTool` 或 `addPrompt`                              |

讀取當前請求的
`requestMetadata.progressToken`，舊版請求也適用。只有存在權杖時才傳送進度。協定日誌與
`Effect.log*`
分開；CLI 下後者寫入 stderr。Effect 負責能力協商和各協定版本的訊息投遞。

## 限制

以下項目未在 Graft 中實作，需要上游 `effect/ai` 或其 RPC 層改動。

| 限制                                     | Effect 邊界                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Toolkit 工具圖示                         | `registerToolkit` 不傳遞圖示                                                                                     |
| Toolkit MRTR                             | Toolkit 處理函式不能回傳 `InputRequired`                                                                         |
| 資源 MRTR                                | `addResource` 不能回傳 `InputRequired`                                                                           |
| 密封或一次性 `requestState`              | 狀態原樣傳遞，不做完整性保護                                                                                     |
| 重新載入後確定性的清單排序               | Effect 保留註冊順序                                                                                              |
| 伺服器 `title`                           | 伺服器選項不接受它                                                                                               |
| 僅現代版本伺服器的 `initialize` 錯誤詳情 | 該路徑的 `-32022` 沒有 `data.supported`                                                                          |
| 非法 JSON 的錯誤標準化                   | stdio 和 socket 協定不回傳帶 `id: null` 的 `-32700`                                                              |
| 自訂傳輸控制訊息和批處理策略             | 內建 RPC 序列化不是公開的 MCP 線協定編解碼器                                                                     |
| socket EOF 會話清理                      | socket 協定報告斷開，但不生成 `Eof`                                                                              |
| 錯誤資料淨化                             | RPC 錯誤可能含有 Effect cause                                                                                    |
| 追蹤 context 傳播                        | 沒有 MCP `traceparent`、`tracestate` 或 `baggage` 整合                                                           |
| 處理函式觸發能力錯誤                     | 沒有用 `-32021` 要求能力的公開輔助函式                                                                           |
| 動態擴充能力和自訂方法                   | 宣告是快照；沒有方法註冊入口                                                                                     |
| 進度單調性和速率限制                     | 沒有公開 MCP 強制檢查 API                                                                                        |
| 傳輸關閉時保證回傳最終監聽結果           | 作用域關閉可能直接斷開，不回傳最終結果                                                                           |
| 補全謂詞                                 | Effect 補全查找不執行項目自身的 `EnabledWhen`；卸載仍會撤回補全                                                  |
| 舊版 HTTP GET                            | 回傳 405；沒有獨立 SSE 串流                                                                                      |
| 舊版 HTTP 恢復                           | 未實作事件重播和恢復                                                                                             |
| 舊版 HTTP 通知                           | 僅透過未關閉的 POST 回應串流傳送                                                                                 |
| HTTP 代理緩衝                            | Effect 不傳送 `X-Accel-Buffering: no`                                                                            |
| HTTP 工作階段生命週期                    | 沒有工作階段到期機制；未保護端點上重複的 initialize 請求可無限配置工作階段狀態。用戶端可用 DELETE 釋放工作階段。 |
| Toolkit `x-mcp-header` 註解              | `registerToolkit` 忽略一般自訂 Schema 註解；底層工具輸入 schema 可用                                             |

Tasks、MCP Apps、Skills、Server Cards 和 `capabilities.experimental`
不在範圍內。Graft 不附帶 MCP 擴充實作。
