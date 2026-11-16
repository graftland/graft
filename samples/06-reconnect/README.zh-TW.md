# 06 · 重連

繁體中文

連線可能中斷。Graft 把存在串流當作真相來源，所以遺失的連線會撤回每個遠端服務，重新連線則把它們帶回來。

你會學到：

- 連線正常期間，connect 掛載會把伺服器上可用的服務鏡射到本機圖裡。
- 連線結束時，遠端服務會被撤回。`Graft.watch`
  先發出目前可用性，再發出每次變化，所以它能顯示每次撤回和每次發布。
- 有了
  `retry`，connect 掛載會開啟新的協定並再次連線。伺服器再次回報該服務時，它會被再次發布。
- 下游掛載遵循同樣的生命週期：服務被撤回時它們停止，服務回來時它們再次啟動。

範例使用 `@graftland/graft/testing`
的記憶體協定，它可以視需要結束目前連線。真實應用依賴 socket、HTTP 回應或 worker 消失時傳輸層隨之結束。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/06-reconnect start
```

```text
The remote service is gone
The remote service is available
Before the drop, the book costs 12
The remote service is gone
The connection dropped and the remote service was withdrawn
The remote service is available
The connection is back and the remote service is published
After reconnecting, the book costs 12
```

第一行是觀察者的初始值：服務還沒有被發布。圖還會在重新連線前記錄失敗的連線嘗試。日誌器會加上時間戳和掛載標註；這裡省略了它們。

## 試一試

- 刪掉 `retry`。斷線後掛載會保持 `Failed`，遠端服務永遠不會回來。
- 在另一個掛載裡使用
  `Graft.whileAvailable(Pricing, ...)`。它會在斷線時停止工作，並在重連後恢復，不需要任何自己的重連程式碼。
