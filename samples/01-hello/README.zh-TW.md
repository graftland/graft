# 01 · Hello

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

你的第一個外掛。它啟動時說 hello，停止時說 goodbye。

你將學到：

- `Plugin.make` 定義外掛。外掛有名稱、設定 schema，以及用來啟動它的 `apply`。
- `Graft.plugin` 載入外掛。正在執行的實例是一個 **fork**。
- `fork.update` 給 fork 一份新設定。預設情況下，外掛會重新啟動。
- `fork.dispose` 卸載外掛。用 `Effect.acquireRelease`
  註冊的清理邏輯會在外掛每次停止時執行。

所有程式碼都在 [`src/main.ts`](src/main.ts) 中。

## 執行

請在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-hello start
```

```text
Hello, Alice!
Goodbye, Alice!
Hello, Bob!
Goodbye, Bob!
```

`Goodbye, Alice!` 來自更新。Graft 會先停止舊實例，再啟動新實例。

## 試一試

- 刪除 `yield* fork.dispose` 這一行。`Goodbye, Bob!`
  仍然會被印出。程式結束時，Graft 會卸載它載入的所有外掛。
- 把 `{ name: 42 }` 傳給
  `Graft.plugin`。TypeScript 會拒絕它，因為設定 schema 規定 `name` 是字串。

下一個：[02 · Services](../02-services)。
