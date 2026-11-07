---
title: 成品快照
description: 在啟動前擷取並驗證已建置的實作。
---

**成品**由擷取的套件目錄和帶版本的 SHA-256 識別組成。識別包含選定的實作入口、目錄項目、檔名和檔案位元組。擷取不會匯入實作。

## 擷取建置產物

```ts
import { Effect } from "effect"

import { Artifact } from "@graftland/plugin-remote"

export const capture = Effect.gen(function* () {
	const artifact = yield* Artifact.capture({
		directory: "./built-integration",
		entry: "dist/index.js",
		store: "./artifacts",
	})
	yield* Artifact.verify(artifact)
	const implementation = yield* Artifact.implementation(artifact)
	return { artifact, implementation }
})
```

| 操作                      | 結果                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `Artifact.capture`        | 將建置好的套件複製到內容定址目錄，回傳位置和識別。                |
| `Artifact.verify`         | 重新計算副本的摘要，回傳識別；驗證失敗則回傳 `ArtifactError`。    |
| `Artifact.implementation` | 驗證副本，回傳擷取入口的檔案 URL，用於部署選項 `implementation`。 |

三種操作都需要明確執行。匯入 `Artifact`
不會存取檔案系統。擷取後的副本不受後續原始碼修改影響。擷取期間偵測到來源檔案變化會中止操作。相同內容重用同一目錄；既有副本損壞時會拒絕操作，不會覆寫它。

驗證發生在對應 Effect 執行時。傳給 `Remote.plugin`
的字串仍是一般模組位置，不會請求擷取或後續驗證。再次啟動前需重新執行驗證。

向[受管理 Remote 外掛](../../transitions/#啟動受管理-remote-外掛)傳入 `artifact`
後，驅動會在每次啟動前驗證工件，復原時也會驗證。

## 宣告重疊支援

在擷取套件的 `package.json` 中宣告：

```json
{ "graft": { "overlap": true } }
```

`Artifact.metadata`
驗證擷取內容後讀取該宣告，不匯入實作。受管理 Remote 在 Change 准入前使用它。宣告缺少或為 false 時選擇 Restart；明確指定的 Overlap 會在候選執行前被拒絕。執行中的實作仍須在描述合約時宣告
`overlap: true`。

## 支援的目錄

| 要求     | 規則                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 套件     | 目錄中包含 `package.json` 和建置好的 `.js`、`.mjs` 或 `.cjs` 入口。                                                          |
| 入口     | 目錄內正規化的相對路徑。                                                                                                     |
| 檔案     | 僅支援一般檔案和目錄。所有符號連結（包括指向目錄外的連結）都會被拒絕。不支援 socket、裝置等特殊檔案。                        |
| 儲存位置 | 必須位於來源目錄外，解析檔案系統別名後也須滿足。                                                                             |
| 依賴     | 擷取目錄內的檔案，包括實際的 `node_modules` 目錄。目錄外的匯入不會被擷取或固定。請打包實作依賴，或保持外部執行環境安裝不變。 |
| 信任     | 這是內容識別，不是沙箱。儲存目錄和執行環境安裝須由維運人員控制。                                                             |

外部執行時期依賴不會被擷取或固定版本，仍屬於操作員管理的執行環境安裝。

不要修改擷取的目錄。驗證會偵測內容變化，但不會修復它。使用符號連結依賴的工作區須先建置為支援的套件目錄。此 API 不提供程式碼傳輸、依賴安裝或自動轉換。
