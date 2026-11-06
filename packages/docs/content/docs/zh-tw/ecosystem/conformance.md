---
title: 外掛一致性測試
description: 使用與第一方外掛相同的公開測試工具驗證已發布外掛。
---

`@graftland/plugin-remote/Conformance`
中的**一致性測試工具**檢查外掛宣告的協定行為。第一方與第三方套件使用相同的檢查，套件名稱不帶來豁免。

編碼檢查讓值通過 `Schema.toCodecJson`，驗證執行期行為，不會將契約轉換為文件。

## 執行測試工具

| 檢查             | 公開呼叫與所需證據                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 清單與程式碼一致 | `Conformance.agreement(directory)` 在啟用前驗證已安裝的建置套件。                                                             |
| 放置位置         | `Conformance.direct(contract, options)` 開啟一個已擷取的 Worker 或 Local 單元，不向應用程式發布服務。對兩種受支援位置都執行。 |
| 可攜編碼         | `Conformance.roundTrip(schema, value)` 使用 Remote 的可攜 JSON codec 與 schema 等價關係，包括非 JSON 值。                     |
| 協定行為         | `Conformance.run(session, suite)` 執行領域範例、項目宣告的探針與取消檢查。每個實作操作都需要範例或握手。                      |
| 資源歸屬         | 在 Effect scope 內提供 Node 服務與安全亂數 layer。關閉 scope 時終止直接單元。                                                 |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

[外掛作者夾具](https://github.com/graftland/graft/tree/main/samples/plugin-authors)
展示獨立的契約套件與實作套件、清單產生、封裝、已安裝宣告編譯、相容性檢查與兩種位置。其中有兩個分別維護的作者夾具與一個第一方夾具；這不是獨立真人採用的證據。

## 提供領域範例

| 預期結果                | 斷言                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `Success`               | 傳回值符合 schema 等價關係，並能完成可攜往返編碼。                                |
| `BusinessError`         | 宣告的錯誤以型別化失敗跨越邊界，而非 `RpcClientError`；提供符合 schema 的預期值。 |
| `InfrastructureFailure` | 呼叫以 `RpcClientError` 失敗，與業務錯誤分開。                                    |
| `Defect`                | 遠端缺陷仍是缺陷 cause，與型別化失敗分開。                                        |

目前沒有公開的 `ContractFailure` 聯合型別。工具檢查現有 Effect
RPC 邊界，不替失敗重新貼標籤。測試操作能夠產生的失敗。直接單元的啟動期限為五秒；每階段期限必須有限，預設五秒。失敗保留其 cause。

成功值與業務錯誤的相等性比較也受每階段截止時間約束。比較逾時的診斷包含操作身分與比較階段。

## 證明取消

提供三個請求：長時間執行的請求、等待其處理器啟動的握手，以及等待請求 finalizer 完成的握手。工具中斷已入場請求，再等待清理握手。回應本身不是清理證據。使用獨立請求，才能在被取消的請求消失後觀察清理。

清理後，工具終止單元、等待執行退出，並檢查後續呼叫以 `RpcClientError`
失敗。`Conformance.run` 完成後，此工作階段不能再處理範例。

直接測試宿主目前支援自包含的單次請求夾具，不支援 RPC 中介軟體或注入的契約服務。測試帶相依的外掛時，把所需提供方組合進夾具套件，並單獨驗證原外掛的清單。通用串流與中介軟體一致性測試尚未實作。範例驗證行為，不能證明所有輸入、原生模組安全或業務語意。
