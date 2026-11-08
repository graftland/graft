# Graft 應用程式

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一個 Graft 應用程式。啟動前先建置原始碼；`graft.yml`
選擇擷取的 JavaScript 檔案。

## 執行

```sh
npm run dev
```

修改 `src/hello.ts` 後，停止行程並再次執行
`npm run dev`。日誌顯示新訊息。修改執行中的應用程式不會觸發重載。

## 指令稿

| Command             | Behavior               |
| ------------------- | ---------------------- |
| `npm run dev`       | 建置並啟動             |
| `npm start`         | 啟動現有建置           |
| `npm run build`     | 將 `src` 編譯到 `dist` |
| `npm run typecheck` | 檢查型別和 Effect 診斷 |

`greeter` 外掛發布 `Greeter`，`ticker`
注入它並每三秒問候一次。pnpm 和 Yarn 也支援這些指令稿。
