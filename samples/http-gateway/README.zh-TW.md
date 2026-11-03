# HTTP 閘道

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一個真實的 HTTP 伺服器，它的路由來自 `graft.yml`
中列出的外掛。編輯該檔案就能新增、移除和重新設定路由，儲存程式碼就能修改路由的程式碼。行程全程保持執行。

## 問題

長期執行的 HTTP 服務通常在啟動時一次性設定好路由。想改變它提供的內容，有兩種選擇。一種是重新啟動，這會丟掉連線和記憶體中的狀態。另一種是手寫一個管理層來修改路由器，而這個管理層還必須記得關閉每個功能開啟的所有資源。相依於某個儲存的功能需要啟動順序，關閉這個儲存則需要為使用它的路由制定處理方案。

## Graft 的做法

- **伺服器對路由一無所知。** `server` 負責監聽，並用 `Event.bail` 把每個請求交給
  `Route` 事件。路由就是外掛內部的一個 `Event.on`
  處理器，所以只要該外掛還在載入，路由就存在。
- **設定檔是唯一的事實來源。** `graft start --watch`
  在每次儲存時，讓執行中的樹與 `graft.yml`
  保持一致。只有發生變化的項目會被動到。如果停用
  `todo-store`，伺服器仍會繼續監聽。如果修改伺服器的
  `port`，伺服器會重新啟動，而不會動到任何路由。
- **相依關係是明確的。** `todos` 注入 `TodoStore`。儲存被停用時，`todos` 處於
  `Pending`，它的路由回傳 404。重新啟用儲存，路由就會回來。`todos`
  中沒有任何程式碼檢查儲存是否存在。
- **程式碼原地重載。**
  儲存外掛模組時，Graft 會匯入新版本，並用它取代正在執行的外掛。行程不會重新啟動。正如[熱重載文件](../../packages/docs/content/docs/zh-tw/hot-reload.md)所說明的，一次程式碼變更會重新啟動從該模組載入的每個外掛，包括伺服器。
- **你能看到這棵樹。** `GET /_graft` 會印出即時的 fork 樹和每個外掛的狀態，包括
  `Pending` 外掛正在等待什麼。

## 執行

在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
cd samples/http-gateway
devenv shell -- pnpm start
```

伺服器監聽 3000 連接埠。在另一個終端機中：

```sh
curl localhost:3000/health
```

```sh
curl localhost:3000/todos
```

```sh
curl -X POST localhost:3000/todos -d '{"title": "Write docs"}'
```

```sh
curl localhost:3000/_graft
```

然後，在它執行的同時：

1. 在 `todo-store` 項目中加入 `disabled: true` 並儲存。日誌只顯示
   `Todo store closed`，沒有其他內容。`/todos` 回傳 404，`/_graft` 把 `todos`
   顯示為 `Pending (waiting for .../TodoStore)`。再把這一行刪掉，`/todos`
   就恢復了。
2. 把伺服器的 `port` 改為 `3001` 並儲存。日誌顯示
   `Stopped listening on http://localhost:3000` 和
   `Listening on http://localhost:3001`。儲存保留著它的 todo。
3. 修改 `src/plugins/health.ts` 中的文字並儲存。日誌顯示
   `Reloaded 5 plugin module(s)`，`/health` 回傳新的文字。

todo 儲存在記憶體中，所以每次重新啟動它時，其中的 todo 都會被重設。

`devenv shell -- pnpm --filter @graftland/sample-http-gateway test`
會在空閒連接埠上啟動伺服器，並透過 HTTP 檢查路由和設定的行為。

## 檔案

| 檔案                        | 說明                                          |
| --------------------------- | --------------------------------------------- |
| `graft.yml`                 | `graft start` 載入的項目。                    |
| `src/Gateway.ts`            | `Route` 事件、`route()` 和 `Gateway` 位址鍵。 |
| `src/TodoStore.ts`          | `TodoStore` 服務鍵。                          |
| `src/plugins/server.ts`     | HTTP 伺服器。                                 |
| `src/plugins/health.ts`     | `GET /health`。                               |
| `src/plugins/inspector.ts`  | `GET /_graft`，即時的 fork 樹。               |
| `src/plugins/todo-store.ts` | 記憶體中的 `TodoStore`。                      |
| `src/plugins/todos.ts`      | `GET /todos` 和 `POST /todos`。               |
| `test/http-gateway.test.ts` | 透過真實 HTTP 進行的測試。                    |
