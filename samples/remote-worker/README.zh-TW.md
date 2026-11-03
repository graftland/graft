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

在 runner 機器上建置並安裝本範例及其執行依賴。安裝目錄下必須有
`node_modules/@graftland/sample-remote-worker/package.json` 和建置後的 `dist`
檔案。套件匯出了 `@graftland/sample-remote-worker/contract`。同時安裝
`@graftland/remote`。這些都是工作區套件，不以已發布到 registry 為前提。宿主和 runner 使用相符的契約版本。

準備專用 CA 簽發的伺服器和用戶端憑證。伺服器憑證必須符合主機名稱，用戶端憑證恰好包含一個 SAN
URI，例如 `graft://demo`。接著執行已安裝的執行檔：

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

等待
`Listening`。建議交給外部行程管理器執行，停止時涵蓋整個行程群組或容器。重新啟動時保留狀態目錄，執行期間不要修改已安裝的套件。

把 `src/main.ts` 中本機的 `formatInChild(...)` 呼叫換成：

```ts
formatInChild({
	contractModule: "@graftland/sample-remote-worker/contract",
	target: Remote.runner({
		instance: "formatter-demo",
		host: "runner.example",
		port: 7443,
		tls: { servername: "runner.example", ca, cert, key: Redacted.make(key) },
	}),
})
```

從 `@graftland/remote` 匯入 `Remote`，從 `effect` 匯入 `Redacted`。這裡的
`ca`、`cert` 和 `key` 是啟用時從宿主檔案讀取的 PEM 內容；將 `runner.example`
換成伺服器主機名稱。[遠端外掛指南](https://graftland.github.io/graft/zh-tw/remote/)
提供完整的 Effect Config 入口，用環境變數設定這些路徑。重新建置，再執行
`start`；這時傳回的 PID 屬於 runner 機器。

直接呼叫時要提供 `instance`。透過 `graft.yml`
載入則可以省略，使用儲存的項目 id。替換網路實例會先等待舊行程退出，再增加 generation。租約、停止結果及保證的邊界見指南。本範例測試只執行本機 target。
