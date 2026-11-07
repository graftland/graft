---
title: 應用程式發佈
description: 在一個應用程式中建置、檢查、套用和回復不可變的受管部署。
---

**應用程式發佈**是由 `@graftland/plugin-release` 管理的內容定址目錄。其
`Releases` 服務透過[變更](../transitions/)更新具名的受管 Worker 和子行程整合。

- 所有變更項目都傳回 `Accepted` 後，目前發佈 id 才會前進。
- 規劃時解碼設定，套用時執行探針和試運行。
- 啟動時選擇日誌中最後一次完整接受的發佈。

## 版本化內容

| 內容         | 發佈中記錄的內容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 實作套件     | 完整的擷取目錄，透過 [Artifact](../remote/artifacts/) 驗證。                                           |
| 設定         | 正規化的 `graft.yml`：項目 id、編碼後的輸入、契約模組、直接部署位置和探針名稱。                        |
| 發佈中繼資料 | `manifests.json` 中產生的清單和以套件為基礎的來源記錄。來源記錄不等於相容性。                          |
| 發佈清單     | `release.json`：項目、能力和憑證參照、撤銷清單。                                                       |
| 不包含       | 業務資料、解析後的秘密值、宿主外掛、宿主切換策略和外部執行階段相依套件。外部相依套件不會被擷取或固定。 |

將儲存目錄放在應用程式的相依解析樹中。套件檔案和設定字面值不得包含秘密值：建置器無法識別任意秘密字面值。使用
`!env NAME` 或
`{ "$env": "NAME" }`；發佈只儲存名稱，在記憶體中解析值。環境參照會自動以
`env:NAME`
加入參照清單。其他能力和憑證參照必須明確列出。每次分配（包括初始啟動、復原和補償）都重新解析參照；保留的期望部署不儲存已解析憑證。

## 建置發佈

發佈來源使用 Loader 項目 id，但只接受受管 Remote 項目。套件目錄相對於來源檔案。
`entry`
選擇套件的公開匯出；套件需要[發佈清單](../ecosystem/manifest/)中由作者維護的欄位。

契約路徑和套件識別符在建置時相對於發佈來源檔案解析。與發佈檢查一致，套件匯出需要支援 Node 預設解析。發佈記錄一個正規化的檔案 URL，規劃和執行使用相同 URL；拒絕其他 URL 通訊協定以及檔案 URL 的查詢參數和片段。契約套件身分和目錄摘要來源記錄維持不變。

```yaml title="forecast-release.yml"
- id: forecasts
  name: "@graftland/plugin-remote"
  config:
    package: ./packages/forecasts
    entry: .
    contract: "@example/forecast-contract"
    target: { _tag: Worker }
    config:
      release: unused
      started: unused
      prefix: updated
      credential: !env FORECAST_TOKEN
    probes: [health]
```

先用匯出的 `build` effect 建立首個發佈，再在宿主中安裝
`plugin({ store, initial, host, socket })`。`host`
提供實際的 Node、Effect、Graft 版本、服務來源記錄和部署能力。預設 Loader 入口接受相同設定，但不含
`budget` 和 `requirements`；嵌入式宿主可向 `plugin`
傳入預算和要求。試運行預設兩秒，其餘預算採用核心預設值。外掛擁有這些整合，不要再透過 Loader 重複載入它們。

## 規劃和套用

將 `@graftland/plugin-release/cli`
啟用為命令外掛。所有命令都連線至執行中應用程式的 Unix
socket；建置路徑也在該處解析。

```sh
graft release build /app/forecast-release.yml --socket /app/control.sock --json
graft release plan TARGET --socket /app/control.sock --json
graft release apply TARGET --expected CURRENT --socket /app/control.sock --json
graft release rollback --expected CURRENT --socket /app/control.sock --json
graft release history --socket /app/control.sock --json
graft release status --socket /app/control.sock --json
```

| 操作     | 規則                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `plan`   | 驗證位元組，檢查服務綁定、來源和執行階段要求，解碼設定。列出程式碼、設定、新增和移除變更。                                    |
| `apply`  | 在發佈鎖內檢查預期的目前 id。僅設定變更也會以新輸入切換同一產物。                                                             |
| 失敗     | `Aborted` 或 `Recovered` 保留先前的 id。較早接受的項目依反向順序透過新的切換補償。                                            |
| 補償失敗 | 將部署標記為 `Degraded`，重新啟動前拒絕後續套用。`RecoveryFailed` 和 `Stuck` 不會被回報為成功回復。                           |
| 邊界     | 拒絕線上新增、移除、契約或部署位置變更，以及非受管編輯。新的項目集合需要另外初始化儲存並重新啟動應用程式。                    |
| 並行     | 一個行程擁有一個儲存。已接納的套用操作屬於外掛作用域，不屬於請求連線。對這些項目只使用 Releases；觀察到外部切換會使規劃無效。 |

補償攜帶已接受 Change 產生的實例實際版本；若後續 Change 已更新版本，補償回報衝突，不覆蓋較新狀態。觀察紀錄區分帶 id 的已准入 Change 和沒有 id 的拒絕。

多項目變更依序進行，不保證整組原子可見。最後接受的 id 與 `Applying` 或
`Degraded`
狀態同時顯示。結束代碼零表示命令成功；拒絕、不成功的切換結果和傳輸失敗傳回非零。`--json`
輸出結構化回覆。

規劃匯入的資源在傳回前釋放。作用中契約的匯入資源由發佈外掛持有，隨外掛關閉。

控制客戶端的十分鐘期限涵蓋連線、回應標頭和回應本文。逾時或中斷會關閉 socket，即使伺服器已連線卻始終不傳送回應標頭。

## 日誌和撤銷

復原時只驗證歷史發佈的位元組和已儲存的中繼資料，不匯入舊實作。只有選取的發佈接受執行階段和來源檢查，因此已淘汰的外部相依套件不會阻止重新啟動。

啟動單元前，復原流程根據已接受的初始化記錄和已完成交易驗證目前、先前的 id 和累計撤銷。每個變更項目都必須有接受結果才能提交。即使符合 schema，日誌內容不一致也會被拒絕；啟動不會將未完成的意圖提升為已接受發佈。

同步並原子替換的日誌記錄意圖、安全的切換結果摘要、目前和先前的 id，以及啟動選擇。中斷的意圖不會繼續執行：啟動從最後接受的發佈建立單元。損毀時拒絕啟動。一起保護日誌和發佈儲存。原始 cause 和解碼後的輸入不會寫入磁碟或控制回覆；行程內呼叫者保留完整 cause。損毀的日誌不會自動修復。

建置會繼承已提交的 `revocations`。`--revoke credential:old` 新增撤銷；
`--reference credential:old`
宣告使用中的參照。套用發佈（包括回復）時，如果其參照與累計撤銷相交就會失敗。`--override-revocations`
明確授權還原，並記錄於日誌；它不會刪除撤銷記錄。撤銷控制發佈選擇，不控制外部憑證簽發方。

socket 目錄僅允許應用程式擁有者存取；socket 權限為
`0600`。宿主閘道放在發佈外掛子樹之外。Graft 負責一個應用程式內的切換；跨執行個體發佈使用現有部署工具。外部步驟和不可逆點不屬於這一發佈層。

## 維運核准

將 `trust`
指向維運政策檔。受政策管理的建構與計畫使用已儲存的發布中繼資料，不在主機匯入實作，也拒絕解析輸入中的環境值；憑證參照應放在主機能力授權中。啟動恢復日誌中的核准與撤銷，回復檢查也包含撤銷的授權參照。核准、撤銷與明確覆寫命令見[信任與隔離](../trust/)。

稽核日誌也會在中繼資料可見前記錄每個變更邏輯視圖的名稱、投影標籤、前後事實與時間。`history`
保留這些修訂，線上核准陳述只保留最新事實。重新啟動時驗證修訂鏈，並恢復最新視圖，即使該視圖尚未獲得核准。
