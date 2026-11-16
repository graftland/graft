# 03 · 失敗與重試

繁體中文

Layer 可能建置失敗。Graft 會保留這個失敗，並在被要求時依排程重試。

你會學到：

- 建置失敗會讓掛載進入 `Failed`，並保留完整的原因。
- `retry` 在每次失敗後依 `Schedule` 重新建置掛載。每次失敗的嘗試都會以帶原因的
  `Failed` 出現在 `mount.state` 裡。
- 在 `mount.state` 裡等待 `Active` 是範例越過失敗的方式；`mount.await`
  用於最終穩定下來的掛載。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/03-failure-retry start
```

```text
Connecting (attempt 1)
The backend is not ready yet
Connecting (attempt 2)
The backend is not ready yet
Connecting (attempt 3)
The mount is active
Using the backend, ready: true
Closing the backend
```

圖還會記錄每次帶 `NotReady` 原因的 `Failed` 嘗試。這裡省略了那些行。

## 試一試

- 刪掉 `retry`。掛載會一直保持 `Failed`，而 `mount.await` 會以 `NotReady` 失敗。
- 給掛載一個有界排程，例如
  `Schedule.recurs(1)`。它會失敗兩次，然後等待變化，而不是一直重試。
