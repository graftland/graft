---
title: 一元呼叫
description: 分別觀察執行額度、結果與取消。
---

**呼叫額度**將獲准的一元呼叫固定至提供方世代。識別包含提供方與使用方的 incarnation、工作階段及請求 id。呼叫走直接的[繫結](../bindings/)通道。

## 觀察呼叫

```ts
import { Effect } from "effect"

import { Kernel } from "@graftland/graft"

export const calls = Effect.flatMap(Kernel.Kernel, (kernel) => kernel.calls)
export const changes = Effect.map(Kernel.Kernel, (kernel) => kernel.callChanges)
```

## 完成

| Fact     | Meaning                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| 結果     | 使用方回報終結 RPC 結果，不代表提供方執行結束。                               |
| 取消     | 要求中斷。取消確認不釋放額度。                                                |
| 完成     | Graft 用原始 Exit 關閉處理函式的 Scope，並保留完成回報直到收到確認。          |
| 原生結束 | 只結束該提供方 incarnation 的執行。使用方結束與連線中斷不能證明提供方已完成。 |

在處理函式中用 `Effect.addFinalizer`
註冊清理。Graft 擁有此 Scope 及其執行。結果可能先於這些清理完成。退役先排空額度再 Stop；排空逾時會要求取消，接著 Stop、終止並等待精確的結束證據。缺少證據時維持 Stuck。

保證限於 Graft 提供的單跳 Scope，不包含 RpcServer 內部的請求 Scope。串流、延遲回覆、捨棄回覆的呼叫與巢狀跨單元完成均被拒絕。原始缺陷與無法歸因的中斷仍然可見。

## 設定限制

```ts
import { Kernel } from "@graftland/graft"

declare const instances: Kernel.Deployment["instances"]
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances,
	callLimits: { concurrency: 64, waiters: 64, wait: 5000 },
})
```

| Field         | Default                                                             |
| ------------- | ------------------------------------------------------------------- |
| `concurrency` | 整個核心最多 64 個已獲准呼叫；溢位為 NotAdmitted。                  |
| `waiters`     | 整個核心最多 64 個等待 Restart 准入的呼叫方；溢位為 NotAdmitted。   |
| `wait`        | 准入佇列最多等待 5,000 ms。逾時或取消會移除等待者，不產生執行額度。 |

Restart 暫停變更的繫結。等待者在獲准時選擇世代，現有呼叫保持固定。登記分派後若遺失且沒有結果，分類為 Unknown；Graft 不重試業務呼叫。取消、結束與完成有保留的控制容量。編碼資料框上限為 1
MiB。這些限制不約束行程總記憶體或外部資源。
