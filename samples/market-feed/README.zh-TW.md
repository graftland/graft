# 行情訂閱

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一條能在交易所不穩定時存活的 BTC-USD 監控管線。`exchange` 發布
`Quotes`。`candles` 把它們彙總成一分鐘的 K 線並發布 `Candles`。`alerts`
回報收盤價至少比開盤價高 1% 的 K 線。如果已載入 Slack webhook，就透過它發送。

```text
exchange --Quotes--> candles --Candles--> alerts
notifier -------------------Notifier----> alerts (optional)
```

交易所是腳本化的。它的連線在第一根 K 線之後中斷，下一次連線嘗試被拒絕，再下一次則成功。不需要網路，也不需要憑證。

## 問題

上游連線中斷時，它後面的每一個階段都會受到影響。如果手工實作，你需要：

- 用戶端中帶退避的重新連線迴圈；
- 一種方式，告訴彙總器和警示器它們的輸入已經沒了；
- 它們各自都要有程式碼，等待輸入恢復並重新訂閱；
- 小心處理，確保背景讀取器中的失敗不會被悄悄丟掉。

新增或移除可選的整合（例如 webhook），也需要它自己的重新設定路徑。

## Graft 的做法

業務外掛只描述在輸入存在時它們做什麼：

- **消費者等待它們的提供者。** `candles` 和 `alerts` 在交易所之前載入，保持
  `Pending`，並顯示它們缺少的鍵。發布 `Quotes` 會啟動整條鏈。
- **背景失敗受到監督。** 交易所的讀取迴圈透過 `Plugin.fork`
  執行。socket 中斷時，Graft 會記錄完整的 cause 並撤回 `Quotes`。它先停止
  `alerts`，再停止 `candles`，然後關閉連線，並把 `exchange` 標記為
  `Failed`。消費者回到 `Pending`。
- **重試就是一個排程。** `retry: Schedule.exponential("400 millis")`
  在 400 毫秒後（被拒絕）和 800 毫秒後（被接受）各嘗試一次新的啟用。同樣的 fork 再次變為
  `Active`。兩個消費者都沒有重新連線迴圈，也沒有對缺少服務的檢查。
- **可選相依只重新啟動它的消費者。** `alerts` 宣告了
  `Plugin.optional(Notifier)`。載入或卸載 notifier 只會重新啟動
  `alerts`，在 webhook 發送和僅寫日誌的發送之間切換。交易所連線和正在進行中的 K 線不會被動到。
- **狀態可觀察。** 執行時會在管線於 `Pending`、`Active` 和 `Failed`
  之間變化時，印出 `Graft.forks` 快照。

Graft 復原的是管線，而不是資料。中斷期間發送的行情不會被重播，資料來源中斷時正在進行的 K 線會被丟棄。回填和可靠投遞是另外的問題。

## 執行

在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-market-feed start
```

輸出中值得注意的內容：

- 第 1 步：兩個消費者都是 `Pending`，各自顯示它所等待的服務。
- 第 3 步：`The plugin's background task failed` 以及 `ExchangeUnavailable`
  cause，然後依序是
  `alerts: stopped`、`candles: stopped`、`exchange: stopped`。大約 400 毫秒後出現
  `connecting (attempt 2)`，被拒絕。
- 第 4 步：再過大約 800 毫秒出現
  `connecting (attempt 3)`，三個 fork 都以原來的 ID 變為 `Active`。
- 第 5 步和第 6 步：notifier 出現和消失時，只有 `alerts` 停止並重新啟動。

`devenv shell -- pnpm --filter @graftland/sample-market-feed test`
會檢查上述每一項說法。它用 `TestClock` 控制重試延遲。

## 檔案

| 檔案                       | 說明                                          |
| -------------------------- | --------------------------------------------- |
| `src/services.ts`          | 行情和 K 線型別、服務鍵、傳輸錯誤。           |
| `src/exchange.ts`          | 建立連線、執行受監督的讀取器、發布 `Quotes`。 |
| `src/candles.ts`           | 一分鐘 K 線；發布 `Candles`。                 |
| `src/alerts.ts`            | 1% 規則和可選的 webhook 發送。                |
| `src/notifier.ts`          | 模擬的 Slack webhook。                        |
| `src/scripted-exchange.ts` | 執行和測試所用的腳本化交易所。                |
| `src/observe.ts`           | 等待狀態和日誌行；fork 樹快照。               |
| `src/main.ts`              | 腳本化的執行。                                |
| `test/market-feed.test.ts` | 上述行為的測試。                              |
