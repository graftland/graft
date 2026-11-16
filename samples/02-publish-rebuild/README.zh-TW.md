# 02 · 發布與重建

繁體中文

設定並不特別。它是一個發布到圖裡的值。需要它的掛載會在值變化時被重建。

你會學到：

- `Graft.publish` 把一個值放進圖裡，並回傳帶 `set`
  的 Publication。值由圖的主管套用，所以如果下一步依賴它，先
  `publication.await`。
- 掛載的 `requires`
  列出 Layer 需要從圖裡取得什麼。只有全部可用時 Layer 才會被建置。
- `publication.set` 替換值。每個需要它的掛載都會被拆除，並用新值重新建置。
- `mount.stable` 等待掛載及其子掛載完成載入。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/02-publish-rebuild start
```

```text
Building the greeter with "Hello"
Hello, world!
Releasing the greeter for "Hello"
Building the greeter with "Hi"
Hi, again!
Releasing the greeter for "Hi"
```

## 試一試

- 在發布 `Config` 之前掛載 `greeter`。掛載會保持
  `Pending`，直到值出現，然後自行建置。
- 刪掉 `requires: [Config]`。TypeScript 會拒絕這個掛載，因為 Layer 需要
  `Config`，但 `requires` 沒有列出它。
