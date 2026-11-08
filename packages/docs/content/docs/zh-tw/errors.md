---
title: 錯誤
description: Graft 中所有具名的錯誤和失敗狀態，以及該如何處理。
---

Graft 會保留每個失敗的完整 `Cause`
並記錄日誌。本頁依來源分組，列出你可能遇到的錯誤。若要從 fork 的狀態或症狀而非錯誤名稱著手，請見[疑難排解](../best-practices/troubleshooting/)。

## fork 失敗

| 名稱                | 觸發時機                                         | 處理方式                                                               |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `SchemaError`       | 外掛的設定解碼失敗。                             | 修正輸入。在設定變更之前，fork 一直處於 `Failed`。                     |
| `Fork.CleanupError` | `dispose` 或自動關閉 Scope 時發生清理失敗。      | 讀取 `cause`：它保留原始的失敗、defect 和混合的中斷原因。              |
| 任務失敗            | `Plugin.fork` 任務以未處理的錯誤或 defect 失敗。 | 在任務**內部**捕捉可復原的錯誤。請參閱[外掛](../plugins/#任務失敗時)。 |

## 服務

`ServiceConflict` 由 `Graft.provide` 拋出，`reason` 說明原因：

| `reason`          | 含義                                     |
| ----------------- | ---------------------------------------- |
| _（無）_          | 同一領域內已有另一個 fork 發布了這個鍵。 |
| `SelfDependency`  | 這次發布會直接重新啟動它自己的提供者。   |
| `DependencyCycle` | 同上，但是經由一連串其他 fork。          |
| `Invalidated`     | 相依項目的變更已使提供者失效。           |

錯誤還帶有發布者的 `fork` ID 和服務的
`realm`。請參閱[發布導致的相依環](../services/#發布導致的相依環)。

## 取代

| 名稱                        | 觸發時機                    | 處理方式                                                    |
| --------------------------- | --------------------------- | ----------------------------------------------------------- |
| `Graft.ReplacementConflict` | 一批取代無法用 alias 表達。 | 檢查 `indices` 指出的配對。請參閱[衝突](../replace/#衝突)。 |

## Intercept

| 名稱                    | 觸發時機                                          |
| ----------------------- | ------------------------------------------------- |
| `UnregisteredReference` | 設定檔中的 `intercept` 鍵尚未註冊。               |
| `InvalidIntercept`      | 值未通過已註冊的 schema。`cause` 是 schema 錯誤。 |

兩種情況下，該項目的外掛都不會啟動。請參閱[設定檔 intercept](../intercepts/#設定檔-intercept)。

## Loader 與設定檔

| 名稱               | 觸發時機                                               |
| ------------------ | ------------------------------------------------------ |
| `CyclicConfig`     | 項目的設定或 intercept 含有環。只有該項目失敗。        |
| `InvalidOperation` | 項目／群組結構本身含有環。                             |
| `StoreError`       | 儲存編輯時，解析、序列化或衝突檢查失敗。檔案保持不變。 |
| `LoaderClosed`     | 在 loader 關閉後才提交編輯。                           |

請參閱 [Loader API](../loader-api/)。

## 熱重載

| 名稱／結果                      | 含義                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `HmrError`                      | 模組無法匯入，或沒有匯出外掛。`cause` 是原始錯誤。                                             |
| `Skipped` / `restart-required`  | 原生載入能力或符號連結目標的變更需要重新啟動。                                                 |
| `Skipped` / `ambiguous-exports` | 原本共用同一個 Plugin 物件的項目，現在匯出了不同的物件。                                       |
| `Skipped` / `identity-conflict` | 取代的身分與執行階段的 alias 不相容。                                                          |
| `RolledBack`                    | 取代失敗或逾時；計入的恢復 fork 為活躍或 `Pending`。`failures` 保留取代失敗及其完整 cause。    |
| `RecoveryFailed`                | 舊程式碼重新啟動失敗。`failures` 保留取代失敗；`recovery` 列出恢復失敗的 fork 及其完整 cause。 |
| `Failed`                        | 重載失敗。值中包含完整的 `Cause`；舊外掛繼續執行。                                             |

請參閱[重載不適用的情況](../hot-reload/#重載不適用的情況)。

## Remote

單元契約透過編碼通道保留已宣告的業務錯誤。在契約的 fromClient 映射中處理 RpcClientError 傳輸失敗。

[呼叫完成](../calls/)和[原生退出證據](../units/)獨立於業務結果。公開 Change 狀態和結果保留 Cause。
