# Graft 外掛

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一個 Graft 外掛套件。`src/index.ts` 定義外掛，`graft.yml` 載入建置後的
`dist/index.js`。

## 執行

```sh
npm run dev
```

修改後停止行程，再次執行 `npm run dev`。不提供自動重載。

## 指令稿

| Command             | Behavior                       |
| ------------------- | ------------------------------ |
| `npm run dev`       | 建置並啟動                     |
| `npm test`          | 執行 `test/`                   |
| `npm run typecheck` | 檢查型別和 Effect 診斷         |
| `npm run build`     | 將 `src` 編譯到發布目錄 `dist` |

pnpm 和 Yarn 也支援這些指令稿。精確的外掛套件名稱優先；否則簡稱 `example` 嘗試
`@graftland/plugin-example` 和
`graft-plugin-example`。兩者都存在時請寫完整套件名稱。
