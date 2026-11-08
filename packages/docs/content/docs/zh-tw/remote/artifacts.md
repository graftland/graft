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

## 支援的目錄

| 要求     | 規則                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 套件     | 目錄中包含 `package.json` 和建置好的 `.js`、`.mjs` 或 `.cjs` 入口。                                                          |
| 入口     | 目錄內正規化的相對路徑。                                                                                                     |
| 檔案     | 僅支援一般檔案和目錄。擷取路徑上的符號連結（包括指向目錄外的連結）都會被拒絕。不支援 socket、裝置等特殊檔案。                |
| 儲存位置 | 位於捕獲閉包之外，解析檔案系統別名後也須符合。允許存放在明確排除的目錄內。                                                   |
| 排除路徑 | 正規化的套件內相對路徑。必須捕獲所選入口和 package.json；不走訪排除的路徑。                                                  |
| 依賴     | 擷取目錄內的檔案，包括實際的 `node_modules` 目錄。目錄外的匯入不會被擷取或固定。請打包實作依賴，或保持外部執行環境安裝不變。 |
| 信任     | 這是內容識別，不是沙箱。儲存目錄和執行環境安裝須由維運人員控制。                                                             |

外部執行時期依賴不會被擷取或固定版本，仍屬於操作員管理的執行環境安裝。

不要修改擷取的目錄。驗證會偵測內容變化，但不會修復它。從擷取閉包中排除符號連結相依目錄，或建置僅包含一般檔案的目錄。排除的外部相依項目不會被擷取。此 API 不提供程式碼傳輸、依賴安裝或自動轉換。

Loader 描述符將已宣告的外部執行依賴標為未捕獲。觀察到的版本與位置不固定其位元組；清單只涵蓋宣告，不涵蓋未宣告的動態匯入。
