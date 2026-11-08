---
title: 公開控制介面
description: 從另一個程序提交並觀察單元 Change。
---

**公開控制介面**透過本機 TCP 端點提供固定中繼資料。在核心作用域中啟動
`Control.serve()`，把傳回的位址交給客戶端。位址包含連線能力憑證。

若要使用獨立行程，解析 `@graftland/plugin-remote/kernel`
的檔案路徑，以部署 JSON 路徑和就緒位址 JSON 路徑作為兩個參數執行。部署資料遵循
`Control.Deployment`；就緒檔案包含 `Control.Address`。匯入執行模組不會啟動工作。

## 提交 Change

```ts
import { Effect } from "effect"

import type { Request } from "@graftland/graft/Kernel"
import { Control } from "@graftland/plugin-remote"

declare const address: Control.Address
declare const request: Request

export const replace = Effect.scoped(
	Effect.gen(function* () {
		const client = yield* Control.connect(address)
		const handle = yield* client.submit({ ...request, key: "deployment-42" })
		return yield* handle.await
	}),
)
```

呼叫和設定由[單元](../units/)編碼；控制介面不載入業務 Schema。

## 觀察

| 讀取                                  | 行為                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `client.get(id)`                      | 傳回帶序號的目前狀態；無鍵的已結算歷史過期後傳回 None。                          |
| `client.observe(id)`                  | 先查詢目前狀態，再提供通知。比較序號，發現缺口後重新查詢。慢觀察者不會阻塞核心。 |
| `client.handle(id).await`             | 等待保留的結論。重複等待傳回相同結論。                                           |
| 斷線或中斷等待                        | 停止觀察；已准入的 Change 繼續執行。重連後按 id 查詢。                           |
| `handle.cancel`                       | 明確請求取消；結算仍需要執行證據。                                               |
| `client.units`、`client.preparations` | 提供原生退出證據、清理分類、Cause 和剩餘預留，包括准入前拒絕留下的事實。         |
| `client.waiters`                      | 傳回選擇代之前有數量上限的排隊呼叫；此時尚未分配提供方執行額度。                 |
| `client.recording`                    | 傳回記錄授權，以及所有未確認的[記錄](../recording/)，包括已結束記錄者的記錄。    |
| `client.supervision`                  | 傳回每個實例最近的監督嘗試與升級狀態，見[監督](../units/#監督)。                 |

## 讀取部署計畫

狀態和結論包含 `members` 對應表與
`plan`。刪除的實例沒有期望目標，首次建立的實例沒有起始目標。每個被選中的實例保留全部選取原因及其前驅。

| 計畫資訊 | 規則                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 本地相依 | 在領域中解析具體提供者；本地邊和明確共置決定部署群組。                                                 |
| 契約相依 | 相容的消費者不進入替換集合，除非其他原因選中它。                                                       |
| 閉包     | 反覆擴展新舊部署群組、本地擷取和宣告的子實例。拆分或合併不會把整個閉包變成一個新群組。                 |
| 放置     | 無約束的群組預設使用 Worker；在生命週期操作前拒絕不相容的明確要求。                                    |
| 預留     | 包括新舊成員關係、查詢過的領域和提供者槽、可選相依的缺失、資源，以及前向執行與復原所需的不同單元容量。 |
| 並行操作 | 提交和復原只套用已預留的修補，保留無關的已接受部署。                                                   |

預設策略是 Restart。明確使用 Overlap 時，每個移動的實例、資源和放置方式都必須允許重疊。缺少提供者、存在相依循環或放置衝突的計畫會在停止舊單元前被拒絕。

## 保留期限

無鍵的已結算歷史有數量上限。有鍵請求和未解決事實保留到執行階段結束。核心重啟後不保留歷史。狀態中的成員、剩餘預算、租約持有者和未確認單元與結果來自同一狀態。
