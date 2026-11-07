---
title: 契約工具
description: 將帶註解的契約操作投影為 MCP 工具，而不改變契約。
---

**投影**透過現有的[工具目錄](../contributing/)公開選定的契約操作。契約仍然是 Effect 值。

- 本地服務與受管 Remote 門面使用相同的綁定。
- 每個工具明確宣告中繼資料和輸出處理方式。
- 更新視圖保留傳輸連線與已准入的呼叫。

## 宣告工具

```ts
import { Context, Effect, Schema } from "effect"
import { Rpc } from "effect/rpc"

import { Plugin } from "@graftland/graft"
import * as Projection from "@graftland/plugin-mcp-server/Projection"
import { Contract } from "@graftland/plugin-remote"

class Forecast extends Context.Service<
	Forecast,
	{
		readonly get: (city: string) => Effect.Effect<string>
	}
>()("example/Forecast") {}

const Get = Contract.operation(
	"example/forecast/Get",
	1,
	Rpc.make("Get", {
		payload: { city: Schema.String },
		success: Schema.String,
	}),
).annotate(Projection.Annotation, {
	name: "forecast",
	title: "City forecast",
	description: "Read a city forecast",
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	output: "json",
})

export default Plugin.make({
	name: "forecast-tools",
	inject: [Forecast],
	apply: () =>
		Projection.offer([
			Projection.operation(Forecast, Get, (forecast, { city }) =>
				forecast.get(city),
			),
		]).pipe(Effect.asVoid),
})
```

使用契約套件匯出的服務鍵和 RPC。呼叫使用貢獻插件注入的服務，因此受管部署透過 fork 持有的門面呼叫。註解可以放在契約套件中，也可以放在宿主明確宣告的 MCP 視圖中。

| 宣告                           | 規則                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `name`、`title`、`description` | 全部必填。工具名稱由 1–128 個字母、數字、底線、點或連字號組成。       |
| 四個提示                       | 全部必填；直接對應到 MCP 註解，不做推斷。                             |
| `output: "json"`               | 用可攜式編解碼器編碼成功值，將 `{ value }` 作為結構化內容和文字回傳。 |
| `output: "void"`               | 捨棄成功值。                                                          |
| 服務與操作                     | 每個組合在視圖中只出現一次；視圖中的工具名稱唯一。                    |

## 載荷與失敗

輸入 schema 從操作載荷的可攜式編解碼器產生，採用 MCP 預設的 JSON Schema
**2020-12**
方言。它只是外部客戶端視圖，絕不參與契約身分、來源紀錄或相容性檢查。執行時仍以 Effect 解碼為準。

`ProjectionError`
指明服務、操作和原因。缺少身分或註解、串流操作、RPC 中介軟體、遞迴或不透明載荷，以及沒有物件根的 schema，都會在發布前被拒絕。Schema 不得需要額外的解碼或編碼服務。這些是投影的限制，不是契約的限制；普通契約操作在 MCP 之外仍然有效。

| 結果                       | MCP 行為                                               |
| -------------------------- | ------------------------------------------------------ |
| 工具參數無效               | 回傳輸入無效的 `isError` 結果；不呼叫服務。            |
| 已宣告的業務錯誤           | 回傳帶 `kind: "business"` 和可攜式錯誤值的 `isError`。 |
| 系統失敗、未宣告錯誤或缺陷 | 回傳經過清理的 `isError`，帶 `kind: "system"`。        |
| 輸出編碼失敗               | 回傳經過清理的系統結果。                               |
| 取消                       | 中斷受管呼叫並等待其清理完成。                         |
| 格式錯誤的協定請求         | MCP 協定錯誤。                                         |

日誌保留完整失敗 cause，並標註服務鍵和操作身分，包括編碼失敗。業務錯誤值會有意公開；不要在其中放置憑證。

呼叫方取消或貢獻插件釋放時，即使呼叫或編碼器的清理也失敗，取消仍然優先。日誌保留完整的混合 cause，不會將其轉換為業務或系統工具結果。伺服器發起的取消以協定錯誤回傳客戶端。

## 發布變更後的視圖

`Projection.offer` 回傳控制器。只修改宿主視圖時使用
`controller.update`。視圖屬於部署變更時，使用
`controller.updateAfter(action, bindings, accepted)`：將 `Graft.transition`
或發布 apply 作為 action，僅接受其 `Accepted`
結局。新視圖在 action 開始前完成驗證。Action 與後續發布歸貢獻插件的 scope 持有，因此取消呼叫方不會遺失已接受的更新。

並行的控制器 action 會在 action 開始前以 `ProjectionError`
失敗，不會排隊。註冊與歷史紀錄以原子方式發布。

宿主必須提供新的帶註解視圖。僅改變 worker 程式碼或發布物，不會將新註解匯入宿主。失敗的 action 保留舊視圖。移除貢獻插件會取消其持有的工作，並先撤下工具，再向已連線的客戶端傳送清單變更通知。

發布會向支援通知的 MCP 會話發出 `notifications/tools/list_changed`。
`Projection.Changed` 記錄修訂號及變更前後的中繼資料，包括服務鍵和操作身分。
`controller.history`
保留最近 32 個修訂；需要持久稽核時，由應用持久化該事件。通知和紀錄不授予批准，也不實作重新批准。

[整合閘道範例](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
使用獨立的 MCP 客戶端檢查工具清單、呼叫、描述變更通知，以及已准入的 v1 呼叫跨越已接受的 v2 轉換而無需重新連線。

透過 stdio 或支援通知訂閱的傳輸發布視圖變更。Effect 4.1.2 的舊版 Streamable
HTTP 轉接器不提供閒置 GET 事件串流（`405`）；此路徑尚未實作主動傳送工具清單變更通知。使用該路徑的客戶端仍可無需重新連線地列出和呼叫工具。上游追蹤：[Effect #10436](https://github.com/Effect-TS/effect/issues/10436)。

## 維運核准

對受政策管理的項目，投影中繼資料屬於精確的[核准聲明](../../trust/)。發布變更後，新呼叫會被阻止，直到重新核准；快取舊工具清單的用戶端也不例外。清單變更通知不是核准，已接納的呼叫仍使用原來的 serving
attempt。

投影驗證 MCP 欄位，並以 `mcp/tools`
標籤發布核准資料。撤下貢獻者會移除其線上工具，但保留核准事實。重新掛載相同中繼資料無需再次核准；發布不同中繼資料會在公開變更前阻止准入。

同一服務操作的不同視圖與歷史中繼資料版本保留各自的核准事實。重新發布未變的視圖，不會抹去另一個視圖，也不會恢復已變中繼資料的核准。
