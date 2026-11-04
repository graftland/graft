# 遠端 worker

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

宿主請子行程轉換文字 `hello`。子行程發布 `Formatter`，宿主注入服務後取得
`Worker: HELLO` 和子行程 PID。宿主只匯入契約，不匯入 worker 實作。

## 執行

使用 Linux 或 macOS，以及 Node.js 22.22 或更新版本。在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

程式輸出
`Worker: HELLO (child ..., host ...)`，兩個 PID 不同；接著關閉作用域，等待子行程退出。不需要憑證或網路服務。測試驗證結果、獨立 PID 和退出確認；它建置自己的子行程執行檔，可以和套件測試平行執行。

## 檔案

| 檔案                         | 用途                                 |
| ---------------------------- | ------------------------------------ |
| `src/contract.ts`            | 設定、服務 key、RPC 對應和實作位置。 |
| `src/worker.ts`              | 在子行程發布文字轉換服務。           |
| `src/host.ts`                | 載入代理、注入服務並呼叫。           |
| `src/main.ts`                | 提供 Node 服務、執行宿主並輸出結果。 |
| `test/remote-worker.test.ts` | 用真實子行程驗證呼叫與清理。         |

`WorkerUnavailable`
把連線失敗保留在服務的型別化錯誤通道裡。呼叫不會重試。子行程擁有一般作業系統權限，獨立行程不等於安全沙箱。

## 放到另一台機器執行

[remote-runner](../remote-runner)
範例透過雙向 TLS 在真實 runner 上執行外掛，並從 `graft.yml`
載入。它的 README 說明了憑證、在 runner 上安裝套件以及啟動
`graft-remote serve`。要讓本範例連線runner，在 `src/main.ts` 裡把 `target` 換成
`Remote.runner(...)`，並設定
`contractModule: "@graftland/sample-remote-worker/contract"`。本範例的測試只執行本機 target。
