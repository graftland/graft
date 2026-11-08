---
title: 執行單元
description: 在原生執行邊界之外執行核心實例。
---

**執行單元**是核心之外的原生執行邊界。Worker 提供故障邊界。不受信任的工作應使用沙箱化的 Process 單元（見[信任原則](../trust/#執行邊界)）。

## 選擇擷取的程式碼

用 `Artifact.capture`
擷取已建置的 JavaScript，再指定選用的契約匯出及編碼設定。外掛與契約匯入、設定解碼都在執行單元內執行。

```ts
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Units from "@graftland/plugin-remote/Units"

declare const artifact: Artifact.Artifact
const target = Units.target({
	artifact,
	contract: "contract.js",
	input: { region: "north" },
	placement: "Worker",
})
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 3,
	instances: [{ id: "forecasts", target }],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
export const inspect = Effect.flatMap(Kernel.Kernel, (kernel) =>
	kernel.inspect({ instance: "forecasts", target }),
)
```

沒有編碼端點的外掛可以省略
`contract`。檢查解碼外掛自己的設定 Schema，不啟動外掛，也不建立虛假的契約。這種目標使用 Restart。

## 准入前檢查

`kernel.inspect`
驗證目標，但不啟動外掛。提交也可以啟動檢查。兩種方式都將檢查及其退出計入總預算。

| 事實 | 規則                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 容量 | 檢查佔用一個執行單元槽位；滿容量時，未快取的檢查可能失敗。                                |
| 重用 | 已驗證宣告要求相同的成品、設定及驗證環境；授權一律重新檢查。                              |
| 拒絕 | `ChangeRejected.preparation` 識別保留的檢查證據，不建立 Change id。                       |
| 觀察 | `getPreparation`、`preparations`、`inspections` 及 `units` 顯示剩餘工作與準確的退出證據。 |
| 等待 | 中斷提交等待者不會取消執行階段擁有的檢查。                                                |

## 單元環境

每個單元建構自己的 Node 服務、HTTP 用戶端、時鐘和記錄器。自訂環境與 intercept 模組匯出 Layer，透過
`Configuration.Options`
接收 JSON 選項。有序設定建構新的 Layer；復原時重新建構，並依目前策略重新解析原始參照。

| 準備方式 | 行為                                                     |
| -------- | -------------------------------------------------------- |
| 模組解析 | 在可丟棄單元中檢查匯出形式，不解碼外掛輸入或呼叫 apply。 |
| 部署檢查 | 建構環境模組並解碼設定，不呼叫 apply 或取得服務資源。    |
| 執行     | 重新建構環境，並重新核對已檢查的宣告。                   |
| 截止時間 | 終止單元並要求原生退出證據；缺少證據時仍保留未結工作。   |

透過 [Loader 準備](../loader-api/)
登記不可變的 intercept 模組。函式、Schema、Context 和 Layer 不會出現在部署資料中。

## 選擇部署位置

| 部署位置  | 執行擁有者                                                           |
| --------- | -------------------------------------------------------------------- |
| `Worker`  | 核心部署服務觀察準確的 Worker 退出。                                 |
| `Process` | 核心部署服務觀察準確的子行程退出。                                   |
| `Runner`  | `Units.serveRunner` 擁有子行程並回報準確的執行身分；僅支援 Restart。 |

Runner 位址包含本機控制通訊端及擁有者身分。斷線不能證明退出。缺少退出證據時，容量及所有權繼續保留。

控制連線正常關閉是偵錯事件。無效或不完整的訊框仍是錯誤。連線關閉與訊框錯誤都不能證明執行單元已退出。

### 模組格式

| 模組                                                 | `Worker`                           | `Process`                             |
| ---------------------------------------------------- | ---------------------------------- | ------------------------------------- |
| ES 模組                                              | 支援                               | 支援                                  |
| CommonJS（`.cjs`，或沒有 `"type": "module"` 的套件） | 支援                               | 支援                                  |
| 原生擴充（`.node`）                                  | 僅當該擴充支援同一行程內多個實例時 | 支援；已透過編譯 N-API 擴充驗證換代。 |

每次重新載入都會啟動新的單元，因此模組的程式碼、快取與原生擴充都是重新載入的，上一代的內容不會留在記憶體中。

## 監督

沒有 Change 負責的故障歸**監督者**處理。它在有界的**重新啟動強度**內重新啟動，超過後停止重試，並保持故障可觀察。上限寫在部署資料中：`supervision: { intensity: 3, period: 60000 }`（預設值）表示每個實例每 60 秒最多嘗試三次。

| 事件                           | 監督者的處理                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| 成員失敗                       | 在其單元內重新啟動它及其本地消費者；健康的同組成員繼續服務。                                 |
| 單元自行結束                   | 先對整組結算，再提交一個部署該組期望目標的 Change。                                          |
| 重新啟動強度耗盡               | 升級該實例：它維持失敗狀態，其他實例不會被重新啟動。針對它的 Change 被接受後，升級狀態解除。 |
| 成員由某個 Change 負責         | 由該 Change 失敗或復原；監督者不另起競爭的嘗試。                                             |
| 重新啟動與執行中的 Change 衝突 | 等待，在該 Change 釋放物件後再次嘗試。                                                       |

嘗試次數依實例計算，不因新的一代而歸零；`Busy`、計畫內的換代及核心關閉都不計數。`kernel.supervision`
與 [`client.supervision`](../control/) 列出最近的嘗試與升級狀態。

## 讀取執行任期

`Plugin.term`
在服務執行單元內提供核心授予的任期。每次嘗試都消耗新任期，包括失敗的啟動。檢查與一般嵌入式呼叫者收到
`UnitOnly`。任期僅於本核心執行期間保留；跨核心重啟的 fencing 需要外部持久協調。
