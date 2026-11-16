# 01 · 掛載 Layer

繁體中文

掛載一個 Layer，它就變成動態的。Graft 會建置它、發布它提供的服務，並在掛載消失時釋放它。

你會學到：

- `Graft.layer` 提供圖。它就是一個一般的 Effect Layer。
- `Graft.mount` 掛載一個一般的 `Layer`。掛載歸目前作用域所有。
- `Graft.use` 等待服務出現，執行函式，並在執行期間持有該服務。
- `mount.unmount` 拆除 Layer；關閉作用域也能做到同樣的事。

範例邏輯在 [`src/program.ts`](src/program.ts) 裡，[`src/main.ts`](src/main.ts)
執行它。

## 執行它

在儲存庫根目錄：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/01-mount-layer start
```

```text
Building the greeter
Hello, world!
Releasing the greeter
```

## 試一試

- 刪掉 `mount.unmount`。程式結束時 greeter 仍會被釋放，因為掛載屬於作用域。
- 掛載 `greeter`
  兩次。你會得到兩個獨立的實例，它們都會在各自的掛載結束時被釋放。
