---
title: MCP 擴充點
description: 使用公開服務和事件編寫傳輸、種類或中介軟體。
---

每個傳輸、貢獻和策略都是普通 Graft 外掛。輔助函式與公開權杖放在一起：匯入時不載入驅動，也不執行 I/O。因此第三方可以使用同一套 API。

## 編寫傳輸

傳輸注入 `Server`，取得新的選項，並在自己的協定上建立 Effect 伺服器。

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
捕獲核心的 context，每次呼叫時取得擴充快照。在傳輸的作用域中建立其
`registrations`。投影、通知和衝突日誌就屬於該傳輸。撤回 `Server`
時，Graft 按普通依賴關係停止其消費者。

## 編寫種類

**種類**將一個項目對映到 MCP 已有的清單。其鍵用於標記貢獻，不是領域鍵。

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

| 規則                                                              | 原因                                              |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `install` 只註冊，不執行 I/O                                      | 目錄事件的發出方會等待每個傳輸                    |
| 每次註冊都傳入 `Catalog.enabledWhen(annotations, ownAnnotations)` | 撤回和衝突隱藏舊註冊；與項目自身的謂詞按 AND 組合 |
| 透過 `completions` 回報補全參數名稱                               | 替換後不會暴露已撤回的補全處理函式                |
| 用 `Catalog.own` 包裝處理函式                                     | 取消時中斷並等待貢獻外掛生命週期內的工作          |
| 同一清單內的識別跨種類唯一                                        | 自訂種類與內建種類沒有特權差異                    |
| 用 `Catalog.advertise` 釋出準備好的貢獻                           | 回答 `Offered`，啟動時和撤回後發出 `Changed`      |

種類可以組合工具、資源和提示詞。增加 JSON-RPC 方法需要上游 Effect API。

目錄變更的派發者等待每個傳輸同步完成。取消派發者後，同步仍歸傳輸所有；卸載傳輸會中斷收集、安裝和通知傳送。在收集或安裝過程中派發
`Changed` 會合併安排後續同步，不會等待自身。

## 編寫中介軟體

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

較小的 `order` 先執行，位於最外層。相同順序按註冊先後排列，`prepend`
優先。若重新載入前後相對順序必須穩定，使用不同的 `order`。`{ global: true }`
可到達所有領域。

| 鉤子            | 行為                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `Middleware`    | 包裝 Effect 的 `MiddlewareMethod` 呼叫，不包含清單、initialize、discover 或 listen |
| `Visible`       | 所有處理函式都必須回傳 true；失敗會使請求失敗                                      |
| `call.services` | 請求 context；在 `next` 前用 `Context.add` 新增服務                                |
| 中介軟體卸載    | 中斷在 `next` 前後仍在執行的處理函式；略過派發者領取前已移除的處理函式             |

可見性檢查先於中介軟體，無法看到中介軟體新增的服務。實作按使用者過濾的清單時，從
`call.services`
讀取傳輸提供的請求身分。中介軟體處理函式使用自己的外掛服務。自訂 MCP 錯誤碼必須在
`-32000..-32019` 內。

HTTP 使用 `@graftland/plugin-http/Authorization` 中的
`Principal`。經過驗證的請求值也會到達受生命週期管理的工具處理函式，並覆蓋外掛中的同鍵服務。

## 宣告擴充

```ts
import { Plugin } from "@graftland/graft"
import { declare as declareExtensions } from "@graftland/plugin-mcp-server/Extensions"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-declaration",
	apply: () => declareExtensions({ "com.acme/notes": { version: "1" } }),
})
```

相同宣告會合併；同一個鍵的不等宣告會隱藏該鍵。衝突和宣告失敗在每個傳輸中每次觀察到新狀態時只記錄一次。傳輸保留啟動時的快照，直到重啟。請求和結果的
`_meta`、註冊註解和可見性仍然使用 Effect 的公開擴充點。

## 測試

`Testing.transport` 建立記憶體傳輸外掛和原始 JSON-RPC 連線，將它與核心並列載入。
`Testing.transportConformance`
檢查探索結果中的身分、設定的協定、貢獻工具、清單變化、資源訂閱 ID、取消和連線關閉。
`Testing.kindConformance` 檢查生命週期、衝突、存活謂詞和部分註冊失敗。

| 測試 | 參數                                                      | 用途                                                                            |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 傳輸 | `expected.name`、`expected.version`、`expected.protocols` | 必填：傳輸所提供選項的預期值                                                    |
| 傳輸 | `expected.close`                                          | 核心 fork 的卸載 effect，驗證撤回會斷開用戶端；另一次執行中省略它以檢查輸入關閉 |
| 傳輸 | `expected.closeTimeout`                                   | 關閉等待時限，預設為五秒；逾時使測試失敗，並說明連線未關閉                      |
| 種類 | `ownDisabled`                                             | 選填：帶有自身 false 謂詞的項目                                                 |
| 種類 | `changed`                                                 | 選填：讀取通知的 effect，檢查每次清單變更                                       |

分別提供和省略 `close`
各執行一次傳輸測試，以檢查依賴撤回和輸入關閉。協定層[限制](../contributing/#限制)仍由 Effect 負責。完整型別見自動產生的
[API 參考](/reference/plugin-mcp-server/readme/)。
