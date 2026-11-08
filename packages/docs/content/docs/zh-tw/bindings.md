---
title: 繫結
description: 透過編碼的一元契約連接固定單元實例。
---

**繫結**為使用方的服務選擇一個提供方。在 `Kernel.layer`
中宣告固定繫結。編解碼器和處理函式在單元內執行；核心只接收宣告與路由資料。

## 宣告繫結

```ts
import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Units from "@graftland/plugin-remote/Units"

declare const provider: Kernel.Target
declare const consumer: Kernel.Target
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances: [
		{ id: "forecasts", target: provider },
		{ id: "gateway", target: consumer },
	],
	bindings: [
		{ consumer: "gateway", provider: "forecasts", service: "app/Weather" },
	],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
```

## 比對契約

| Rule   | Requirement                                                                           |
| ------ | ------------------------------------------------------------------------------------- |
| 提供方 | 同一提供方必須涵蓋所有必要操作，不合併多個提供方的部分操作。                          |
| 識別   | 必要的不可變 `name@version` 識別必須是提供方宣告的子集。                              |
| 來源   | 兩個目標使用同一份已擷取的 `contractArtifact`。同一識別的來源或線路標籤不同會被拒絕。 |
| 形式   | 只支援一元操作。重複操作識別和服務鍵在 Describe 階段失敗。                            |

## 安裝檢視

提供方升級先在每個執行中的使用方安裝受影響的路由，再啟用。缺少或過期的確認不能啟用檢視。安裝失敗會捨棄暫存檢視；缺少參與方的結束證據仍是未解決的義務。

提供方處理函式使用提供方自己的 Context 和 Scope。通道編碼酬載、型別化錯誤和結果。只有
`traceparent`、`tracestate`
與 Graft 來源、能力及票據中繼資料跨越邊界；任意呼叫方標頭和 Context 服務不會傳遞。
