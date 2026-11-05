# @graftland/create

[English](https://github.com/graftland/graft/blob/main/packages/create/README.md)
|
[简体中文](https://github.com/graftland/graft/blob/main/packages/create/README.zh-CN.md)
| 繁體中文

產生新的 Graft 專案。支援的 Node.js 最低版本是 22.19。

```sh
npm create @graftland@latest my-app
```

`npm create @graftland` 執行本套件的 `create` 命令，也就是
`graft create`。它會問幾個問題，每個都有預設值；使用
`--yes`，或終端機無法回答時，全部採用預設值。它寫入三種範本之一（`app`、`plugin`
或 `minimal`），接著安裝相依套件並執行 `git init`。

要在自己的程式中建立專案，請使用本套件的
`create`。它不提問、不安裝，也不執行 git：

```sh
npm install @graftland/create effect
```

```ts
yield * Create.create({ directory: "my-app", template: "plugin" })
```

## 文件

- [命令列](https://graftland.github.io/graft/zh-tw/cli/#graft-create)

屬於 [Graft](https://github.com/graftland/graft)。採用
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權。

## 套件管理器宣告

共用的 `PackageManagerDeclaration` Schema 接受 `npm`、`pnpm` 或
`yarn`，後接精確的 SemVer 版本（版本部分最多 256 個字元），可包含預發布識別碼。它拒絕空後綴、版本及預發布數字識別碼的前置零、版本範圍、標籤、URL 和首尾空白。

`+` 後綴僅用於
[Corepack hash](https://github.com/nodejs/corepack#when-authoring-packages)：支援
`sha224`、`sha256`、`sha384`、`sha512`，後接點號及分別為 56、64、96、128 個字元的小寫十六進位摘要。不支援一般 SemVer
build metadata。這裡只檢查宣告語法，不下載或驗證套件管理器壓縮檔的真實性。

建立專案與偵測套件管理器使用同一個 Schema，可從
`@graftland/package-manager/PackageManagerDeclaration`
匯入。建立時完整保留傳入的宣告；偵測時明確指定的 `agent`
仍優先於 manifest 宣告。
