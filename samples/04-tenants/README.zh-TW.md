# 04 · 租戶

繁體中文

兩個租戶在一個行程裡執行同一套 Layer。每個都有自己的筆記，每個掛載讀取自己的租戶名。兩個 Layer 都不接收租戶 ID。

你會學到：

- `isolate`
  讓服務在掛載之下擁有自己的領域。兩個掛載可以發布相同的服務鍵，而不會觸發
  `ServiceConflict`。
- 像 `[Notes, "acorn"]`
  這樣的標籤會把使用該標籤的所有掛載放進同一個共享領域。使用相同標籤的消費者會看到同一個服務。
- `intercept` 為一個掛載及其下所有內容調整引用。`Graft.intercept(Tenant, ...)`
  給每個掛載自己的租戶名。
- 卸載一個租戶不會影響其他租戶及其服務。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/04-tenants start
```

```text
Opening notes for "acorn"
Opening notes for "northstar"
Saving "launch checklist" for "acorn"
Reading notes
  { texts: [ 'launch checklist' ] }
The reader stopped
Closing notes for "acorn"
Acorn left; Northstar still has its own notes
Saving "launch checklist" for "northstar"
Reading notes
  { texts: [ 'launch checklist' ] }
```

## 試一試

- 刪掉 `isolate` 選項。兩個掛載會在同一個領域發布 `Notes`，所以第二個會以
  `ServiceConflict` 失敗。
- 把 Acorn 的標籤改成
  `"northstar"`，但不改它的 intercept。讀取者現在會看到 Northstar 的筆記，因為標籤選擇領域。
