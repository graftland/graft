# 05 · Config file

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

這裡的外掛和之前是同一類。不同的是，這次由 `graft`
指令從設定檔載入它們。你透過編輯檔案來修改正在執行的應用程式。

你將學到：

- 外掛模組把它的外掛作為預設匯出。參見 [`src/greeter.ts`](src/greeter.ts) 和
  [`src/ticker.ts`](src/ticker.ts)。
- [`graft.yml`](graft.yml) 列出要載入哪些外掛，以及每個外掛使用什麼設定。
- `graft start --watch`
  會把每次儲存的修改套用到正在執行的應用程式上，只改動發生變化的部分。

## 執行

請在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
cd samples/05-config-file
devenv shell -- pnpm start
```

```text
Running graft.yml
Hello, Alice!
tick
tick
```

保持它執行，然後編輯這個資料夾中的檔案：

1. 在 `graft.yml` 中，把 `name: Alice` 改成 `name: Bob` 並儲存。你會看到
   `Goodbye, Alice!` 和 `Hello, Bob!`。ticker 繼續計時，因為它的項目沒有改變。
2. 給 `ticker` 項目加上 `disabled: true`
   並儲存。tick 會停止。刪除這一行後，它們會重新開始。
3. 在 `src/greeter.ts` 中，把 `Hello` 改成 `Hi there`
   並儲存。Graft 會匯入新程式碼並取代正在執行的外掛：`Goodbye, Bob!`、`Hi there, Bob!`。

按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 停止。Graft 會卸載所有外掛。

## 下一步
