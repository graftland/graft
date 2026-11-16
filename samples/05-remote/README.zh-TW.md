# 05 · 遠端

繁體中文

服務可以活在另一個圖或另一個行程裡，而呼叫方無須知道。傳輸層就是一個
`effect/rpc` Protocol。

你會學到：

- `Remote.service` 宣告一個契約：本機服務鍵、一個
  `RpcGroup`，以及它們之間的兩種對應。
- `Remote.serve`
  暴露每個服務目前可用的契約。它回傳一個 Mount，所以歸目前作用域所有。
- 連線期間，遠端服務會在本機發布。`Graft.use`
  等待它，在呼叫期間持有它，隨後釋放它。
- 可用性會經由連線傳遞，所以伺服器上消失的服務在用戶端也會消失。

範例使用 `@graftland/graft/testing`
的記憶體協定。真實應用則傳入 socket、HTTP 或 worker 協定。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/05-remote start
```

```text
The book costs 12
```

## 試一試

- 刪掉伺服器上的 `pricing` 掛載。用戶端會停在 `Graft.use`
  裡等待，而不是收到價格。
- 給 `PricingRpcs` 加第二個 RPC，並給 `Pricing`
  加第二個方法。契約雙向攜帶，所以遠端服務也會有它。
