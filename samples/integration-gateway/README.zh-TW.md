# 整合閘道

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

替換獨立打包的天氣整合時，保留同一個 WebSocket 機器人工作階段。本機伺服器模擬登入、心跳、工作階段 id 和訊息，不需要機器人帳號。

## 執行

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start
```

```sh
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/v2
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/broken-probe
```

把 `PORT` 換成輸出的操作連接埠。第一則訊息回傳 v1 預報。升級回傳
`Accepted`，下一則訊息回傳 v2。失敗的 probe 回傳帶有 cause 的
`Aborted`，目前版本繼續服務。按 Ctrl+C 停止。

要觀察復原，POST `/upgrade/broken-trial`，在它等待期間，從另一個終端機 POST
`/message/crash`。結果為
`Recovered`，先前固定的產物在新單元中啟動。測試會故意損壞該舊產物，示範
`RecoveryFailed`。

端點監聽 localhost，只接受範例中列出的版本。它用於本機示範，不是經過身分驗證的部署服務。

## 套件與資源歸屬

| 部分                             | 職責                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `contract/`                      | 公開服務 key、RPC 操作識別和業務輸入。                  |
| `v1/`、`v2/`                     | 獨立打包的實作，宣告 `provides` 和 `overlap`。          |
| `broken-probe/`、`broken-trial/` | probe 拒絕和試行視窗內的失敗。                          |
| `src/gateway.ts`                 | 宿主擁有的 WebSocket 協定配接器和注入服務的命令消費者。 |
| `src/app.ts`                     | 產物擷取、Loader 項目 `forecasts` 和操作端點。          |

啟動器把 Graft 建置後的公開匯出打包到儲存庫之外的暫存專案，安裝它們，編譯並打包契約和實作，再安裝這些 tarball。消費者編譯不使用原始碼別名或私有匯入。同一套安裝後的程式碼用於 Worker 和子行程。

啟動時在暫存專案中建立 `config/graft.yml`。`forecasts` 項目指定
`@graftland/plugin-remote`、已安裝的契約、相對的產物目錄和直連部署方式。操作端點呼叫
`Graft.transition({ target: "forecasts", candidate })`，不重寫檔案。Loader 在持久化前拒絕受管理樹的編輯。

產物只固定套件的位元組內容。外部執行階段依賴不會被擷取或固定版本。結束時刪除暫存專案及其產物。

## 驗證

```sh
devenv shell -- pnpm --filter @graftland/sample-integration-gateway test
```

測試執行兩種直連部署方式和真正的 `graft start` 命令，檢查：

- 只登入一次，工作階段 id 不變，閘道和消費者的啟用次數不變。
- 正常升級和重複升級後回應更新，舊單元有結束證據。
- probe cause、試行復原和復原失敗期間，工作階段仍然保留。
- 已接納的慢 v1 請求在切換後仍由 v1 完成。
- 被拒絕的 Loader 編輯不改變檔案和已接受目標。

工作區測試套件執行同一套已安裝消費者測試。
