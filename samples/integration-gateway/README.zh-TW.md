# 閘道整合

替換注入的整合單元時，閘道維持同一條上游連線。

## 執行

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Worker Overlap
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Process Restart
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Runner Restart
```

命令啟動獨立核心行程，擷取已建置的 JavaScript，保留一個舊代一元呼叫，升級至版本 2，並依 Change
id 重新連接控制通道，接著嘗試一個健康探針會失敗的版本 3。

## 觀察

報告顯示 Accepted、版本 1 與 2、故意出錯的升級以 `Aborted`（Overlap）或
`Recovered`（Restart）結束且版本 2 繼續服務、一個閘道單元和上游工作階段、ExplicitTarget 選取原因、目前程式碼健康狀態、舊單元原生退出、零剩餘 Change 租約與未確認單元、剩餘預算和原始 cause。

## 邊界

Worker 是故障邊界。本範例不隔離不受信任的程式碼，不保證閘道或核心死亡後的工作階段延續，也不以強制退出證明 finalizer 成功。
