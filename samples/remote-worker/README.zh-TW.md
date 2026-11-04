# Remote worker

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

宿主兩次呼叫同一個 `Formatter` 服務：先用 `Remote.local()` 啟動子行程，再用
`Remote.worker()` 啟動 Node worker。兩者都回傳 `Worker: HELLO`。宿主只匯入契約。

## 執行

使用 Linux 或 macOS、Node.js 22.22 或更新版本。在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

local 結果的 PID 與宿主不同，thread 為 0；worker 與宿主共用 PID，threadId 為正數。每個 scope 關閉時都會 dispose 代理並等待退出。兩者都不需要 runner 或憑證，generation 每次都是 1。

`src/host.ts` 明確載入 `host/local`、`host/worker`，再載入代理與服務使用者。
`src/contract.ts` 定義 RPC 對應，`src/worker.ts` 提供服務， `src/main.ts`
依序選擇兩個 target。測試驗證兩次回傳值、行程與執行緒身分，以及子行程退出。先 build 再執行：worker
target 會啟動已安裝的 remote worker 執行檔。

`WorkerUnavailable` 將連線失敗保留為服務錯誤，呼叫不會重試。Node
worker 與宿主共用行程和權限，只隔離執行，不隔離檔案或網路存取。子行程也擁有正常的作業系統權限。

wss/JWT runner、持久化 generation 與 SSH/stdio 用法見
[remote-runner](../remote-runner/README.zh-TW.md)。
