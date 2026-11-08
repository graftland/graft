---
title: 插件一致性
description: 檢查發佈中繼資料、編解碼器和領域範例。
---

**一致性工具**檢查作者提供的協定範例，提供中繼資料與編解碼檢查以及領域工作階段測試。

## 執行檢查

| 檢查                    | 證據                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `Conformance.agreement` | 驗證已安裝的建置套件與其清單是否一致。                                                     |
| `Conformance.roundTrip` | 檢查可攜式 JSON 編碼及 Schema 等價性，包括非 JSON 值。                                     |
| `Conformance.run`       | 透過提供的工作階段檢查範例、已宣告探針和取消；每個已實作的服務與操作組合都需要案例或交握。 |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

## 提供領域範例

每個請求指定 Context 服務鍵和確切的操作識別。工作階段提供呼叫、編解碼比較、探針以及獨立觀察到的終止證據。操作識別相同的兩個服務仍相互獨立。失敗保留 Cause。每階段期限必須有限，預設為五秒。

## 證明取消

提供一個長呼叫、證明處理程序已開始的交握，以及證明所擁有清理已完成的交握。測試中斷請求，在終止前檢查清理。結果本身不是清理證據。終止後再次呼叫必須以 RpcClientError 失敗。
