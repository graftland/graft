---
title: 執行單元
description: 在原生執行邊界之外執行核心實例。
---

**執行單元**在核心之外擁有一個固定外掛成員。Worker 提供故障邊界。不受信任的工作應使用沙箱行程部署。

## 選擇擷取的程式碼

用 `Artifact.capture`
擷取已建置的 JavaScript，再指定契約匯出及編碼設定。契約匯入與設定解碼在執行單元內執行。

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

## 選擇部署位置

| 部署位置  | 執行擁有者                                                           |
| --------- | -------------------------------------------------------------------- |
| `Worker`  | 核心部署服務觀察準確的 Worker 退出。                                 |
| `Process` | 核心部署服務觀察準確的子行程退出。                                   |
| `Runner`  | `Units.serveRunner` 擁有子行程並回報準確的執行身分；僅支援 Restart。 |

Runner 位址包含本機控制通訊端及擁有者身分。斷線不能證明退出。缺少退出證據時，容量及所有權繼續保留。

## 讀取執行任期

`Plugin.term`
在服務執行單元內提供核心授予的任期。每次嘗試都消耗新任期，包括失敗的啟動。檢查與一般嵌入式呼叫者收到
`UnitOnly`。任期僅於本核心執行期間保留；跨核心重啟的 fencing 需要外部持久協調。
