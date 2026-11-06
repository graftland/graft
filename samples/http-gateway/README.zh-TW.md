# HTTP 閘道

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由是 `@graftland/plugin-http`
上的掛載。每個路由外掛擁有自己的請求與串流；外掛載入、卸載或熱替換時，共用伺服器繼續監聽。

Todos 使用 Effect HttpApi 契約與型別化用戶端測試。組合外掛在 `/openapi.json`
提供即時文件；同層 Scalar 外掛提供 `/docs`。

## 執行

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/http-gateway && pnpm start"
```

伺服器綁定 `127.0.0.1:3000`。在另一終端機執行：

```sh
curl 127.0.0.1:3000/openapi.json
curl 127.0.0.1:3000/docs
curl 127.0.0.1:3000/health
curl 127.0.0.1:3000/todos
curl -X POST 127.0.0.1:3000/todos -H 'content-type: application/json' -d '{"title": "Write docs"}'
curl -X DELETE 127.0.0.1:3000/todos/1
curl 127.0.0.1:3000/_graft
```

## 編輯

1. 在 `graft.yml` 中為 `todo-store` 設定 `disabled: true`。`/todos`
   傳回 404，`/_graft` 顯示 `todos` 為 `Pending`。移除設定後路由恢復。
2. 修改 `src/plugins/health.ts` 的回應文字。日誌顯示
   `Reloaded 1 plugin module(s)`，`/health` 傳回新文字；不會出現新的
   `Listening on` 日誌。
3. 執行 `curl -N 127.0.0.1:3000/events`，再停用 `events`。串流關閉，`/health`
   仍可用。
4. 將伺服器連接埠改為 3001。日誌顯示
   `Stopped listening on http://127.0.0.1:3000` 和
   `Listening on http://127.0.0.1:3001`；路由外掛保留狀態。
5. 在 `src/plugins/todos.ts` 中把建立待辦的標題改為
   `payload.title + " (edited)"`。日誌顯示
   `Reloaded 1 plugin module(s)`。POST 新待辦的標題包含
   `(edited)`，GET 仍傳回既有待辦。不會新增 `Listening on` 日誌；`/openapi.json`
   與 `/docs` 仍可用。

待辦儲存位於記憶體中，外掛重新啟動後重設。`DELETE /todos/:id`
刪除成功傳回 204，id 不存在時傳回 404。

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

## 檔案

| 檔案                                            | 用途                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `graft.yml`                                     | 路由核心、監聽器、各路由外掛、HttpApi 組合外掛及其 Scalar 頁面。 |
| `src/plugins/health.ts`                         | 健康檢查掛載。                                                   |
| `src/plugins/inspector.ts`                      | 顯示即時外掛樹的掛載。                                           |
| `src/TodoStore.ts`, `src/plugins/todo-store.ts` | 待辦路由所需的依賴。                                             |
| `src/api/Todos.ts`                              | 共用 HttpApi 契約與型別化錯誤。                                  |
| `src/plugins/todos.ts`                          | 同一掛載中的 GET、POST 與 DELETE 路由。                          |
| `src/plugins/events.ts`                         | 卸載時中斷的 SSE 掛載。                                          |
| `test/http-gateway.test.ts`                     | 在系統分配的連接埠上執行真實 HTTP 測試。                         |
