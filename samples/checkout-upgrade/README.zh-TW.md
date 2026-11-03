# 結帳升級

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

在升級定價引擎、資料庫容錯移轉到新主機的同時，一個訂單 worker 持續消費佇列。沒有訂單遺失，沒有訂單被處理兩次，也沒有任何查詢會落到已關閉的連線池上。

## 問題

在執行中的服務裡替換相依套件，正是關閉類 bug 的高發地。要在不重新啟動的情況下替換定價引擎或遷移到新的資料庫主機，通常需要：

- 停止接收新任務，但完成已在進行中的訂單；
- 依正確的順序，先停止所有使用舊引擎或舊連線池的部分，再關閉它；
- 啟動新的引擎或連線池，再讓使用者基於它重新啟動；
- 在整個過程中保持佇列和已儲存的資料完好。

大多數服務選擇放棄，直接重新啟動行程，導致進行中的任務遺失。或者為每個相依套件手寫一套自訂的排空並替換流程。

## Graft 的做法

外掛的寫法就好像一切都不會改變。`checkout` 在 `apply` 中只讀取一次 `Database` 和
`Pricing`。`order-worker` 只讀取一次 `Checkout`。變更由 Graft 處理：

- **`Graft.replace([[pricingV1, pricingV2]])`**
  用新引擎重新啟動舊引擎的每一個 fork。在 `Pricing v1 unloaded`
  之前，Graft 先停止 worker，再停止
  `checkout`，因為它們使用 v1 發布的內容。然後依相依順序啟動 v2、`checkout`
  和 worker。TypeScript 會檢查 v2 接受與 v1 相同的輸入。
- 對資料庫呼叫
  **`fork.update({ url })`**，會用新主機重新啟動它，順序相同。worker 先完成已取走的訂單，`checkout`
  停止，然後舊連線池關閉，新連線池開啟。
- **停止時會等待進行中的任務。**
  worker 以不可中斷的方式處理每個訂單。Graft 會停止 `Plugin.fork`
  任務並等待它們結束，然後才撤回它們所用的任何服務。
- **比外掛存活更久的東西放在環境中。** 訂單佇列和資料庫的儲存被提供給
  `Graft.layer`，所以它們能撐過每一次重新啟動。替換期間抵達的訂單會在佇列中等待。

資料庫外掛會把對已關閉連線池的查詢變成 defect。因此，如果順序出過錯，worker 會失敗，執行輸出中會顯示錯誤。

## 執行

在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade start
```

輸出中值得注意的內容：

- 第 2 步：`Order worker stopped`、`Checkout down`、`Pricing v1 unloaded`，然後這三者以 v2 重新啟動。此後的訂單由 v2 定價：三件商品的購物車從 $52 降到 $46.8。
- 第 3 步：進行中的訂單在 `db-1` 上完成，_先於_ `Order worker stopped` 和
  `Closed pool to postgres://db-1...`。
- 第 4 步：`24 orders placed, 24 receipts, 24 distinct orders`。

`devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade test`
會檢查上述每一項說法。

## 檔案

| 檔案                            | 說明                                         |
| ------------------------------- | -------------------------------------------- |
| `src/Orders.ts`                 | 訂單佇列和資料庫儲存，二者都在環境中。       |
| `src/Checkout.ts`               | `Database`、`Pricing` 和 `Checkout` 服務鍵。 |
| `src/plugins/database.ts`       | 開啟連線池並發布 `Database`。                |
| `src/plugins/pricing.ts`        | 定價引擎 v1 和 v2。                          |
| `src/plugins/checkout.ts`       | 為訂單報價並儲存；發布 `Checkout`。          |
| `src/plugins/worker.ts`         | 從佇列中逐個取出訂單。                       |
| `src/main.ts`                   | 腳本化的執行。                               |
| `test/checkout-upgrade.test.ts` | 上述行為的測試。                             |
