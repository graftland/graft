# HTTP 閘道

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由、Effect HttpApi 契約和具型別的用戶端共用一個 HTTP 接聽器。`/openapi.json`
發布 API，`/docs` 提供 Scalar。

## 執行

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/http-gateway && pnpm start"
```

```sh
curl 127.0.0.1:3000/health
curl 127.0.0.1:3000/openapi.json
curl 127.0.0.1:3000/docs
curl 127.0.0.1:3000/todos
curl -X POST 127.0.0.1:3000/todos -H 'content-type: application/json' -d '{"title":"Write docs"}'
curl -X DELETE 127.0.0.1:3000/todos/1
```

## 修改

修改原始碼模組或 `graft.yml` 後，停止行程，重新建置並啟動。`start`
讀取一個版本，不支援 `--watch`。

## 測試

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

測試直接嵌入協作式外掛，在系統分配連接埠的真實接聽器上執行。它們驗證路由清理和組合，不證明核心隔離。

## 檔案

| File                        | Role                                           |
| --------------------------- | ---------------------------------------------- |
| `graft.yml`                 | Listener, router, mounts and API documentation |
| `src/plugins/health.ts`     | `/health`                                      |
| `src/plugins/events.ts`     | `/events`                                      |
| `src/plugins/todo-store.ts` | In-memory `TodoStore`                          |
| `src/plugins/todos.ts`      | GET, POST and DELETE                           |
| `src/api/Todos.ts`          | HttpApi contract                               |
| `dist/`                     | Built modules selected by configuration        |
