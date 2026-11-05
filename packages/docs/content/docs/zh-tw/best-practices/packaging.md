---
title: 外掛套件
description:
  把外掛發布為 npm 套件，讓應用程式依名稱載入、在其上建構，並能安全升級。
---

**外掛套件**是一個 npm 套件，它的模組匯出外掛。應用程式安裝它之後，可以在
`graft.yml`
中依名稱載入，或從程式碼匯入，並針對它宣告的服務和事件撰寫自己的外掛。先用
`plugin`
範本建立套件，並遵守[發布外掛](../../plugins/#發布外掛)中的三條規則；本頁說明其餘事項。

## 規劃套件結構

把消費者在其上建構的識別物件，和實際執行的外掛分開。識別物件該包含什麼，請參閱[在共用模組中宣告識別物件](../design/#在共用模組中宣告識別物件)。

```ts title="src/tokens.ts"
import { Context, Effect, Schema } from "effect"

export class Database extends Context.Service<
	Database,
	{ readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>> }
>()("graft-plugin-postgres/Database") {}

export const Config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
	poolSize: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
})
```

```ts title="src/index.ts"
import { Effect, Redacted } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Config, Database } from "./tokens.js"

declare const openPool: (
	url: Redacted.Redacted<string>,
	size: number,
) => Effect.Effect<{
	readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>>
	readonly close: Effect.Effect<void>
}>

export default Plugin.make({
	name: "postgres",
	config: Config,
	apply: ({ url, poolSize }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				openPool(url, poolSize),
				(pool) => pool.close,
			)
			yield* Graft.provide(Database, { query: pool.query })
		}),
})
```

每個部分各自作為一個入口點匯出：

| 匯出         | 內容                                                  | 由誰匯入                                                                          |
| ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `.`          | 外掛，作為預設匯出或名為 `plugin` 的匯出。            | 載入器，對應 `graft.yml` 中的 `name:`。                                           |
| `./tokens`   | 服務鍵、事件、Reference、tagged error 和設定 schema。 | 消費者外掛、測試，以及實作同一個服務的其他套件。                                  |
| `./<plugin>` | 另一個外掛，每個模組一個。                            | 像 `name: postgres/migrations` 這樣的設定項目。                                   |
| `./contract` | [Remote 契約](../../remote/hosts/#定義契約)。         | 外掛可在別處執行時，由宿主和 [runner](../../remote/runners/#架設-runner) 匯入。   |
| `./schema`   | 設定的[編輯器登記項目](#編輯器自動補全)。             | 應用程式的編輯器 Schema。                                                         |
| `./cli`      | 為 `graft` 加入子命令的命令外掛。                     | [`graft add --plugin <package>`](../../cli/#命令外掛)，它會啟用 `<package>/cli`。 |

| 規則                           | 避免的問題                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `./tokens` 不匯入任何實作。    | 只注入 `Database` 的外掛，或偽造它的測試，都會連帶載入你的驅動程式及其相依套件。                   |
| 每個模組一個外掛。             | 載入器從一個模組只取一個外掛：預設匯出，否則取 `plugin`。其他匯出的外掛無法在 `graft.yml` 中指名。 |
| 契約以 `module` URL 指向實作。 | 從契約匯入實作，會讓宿主也載入它，而不只是外掛行程。                                               |

## 宣告相依套件

```json title="package.json"
{
	"name": "graft-plugin-postgres",
	"version": "1.0.0",
	"type": "module",
	"sideEffects": false,
	"engines": { "node": ">=22.19.0" },
	"exports": {
		".": "./dist/index.js",
		"./tokens": "./dist/tokens.js",
		"./schema": "./dist/schema.js"
	},
	"peerDependencies": {
		"@graftland/graft": "^0.4.0",
		"effect": "4.1.*"
	},
	"devDependencies": {
		"@graftland/graft": "0.4.1",
		"effect": "4.1.2"
	},
	"dependencies": {
		"postgres": "^3.4.0"
	}
}
```

| 套件                                                              | 列在                                    | 原因                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`、`@graftland/graft`                                      | `peerDependencies` 和 `devDependencies` | 應用程式中[每個都只能有一份](../../hot-reload/#外掛模組的規則)。若列在 `dependencies`，只要應用程式那份不符合你的範圍，就會再安裝第二份。 |
| `@graftland/loader`、`@graftland/cli`、`@graftland/plugin-remote` | 同上，僅限你的模組有匯入它們時          | 它們與 `@graftland/graft` 一起發佈並鎖定其版本，因此請給相同的範圍。                                                                      |
| 其他所有套件，例如驅動程式和用戶端                                | `dependencies`                          | 它們是你的套件私有的。                                                                                                                    |

## 撰寫可載入、可重載的模組

設定項目載入你的外掛時，應用程式會匯入外掛模組；在 `graft start --watch`
下熱重載時會再匯入一次。套件中的每個檔案都要遵守[外掛模組的規則](../../hot-reload/#外掛模組的規則)，並[在 `apply` 中取得資源，而不是在匯入時](../effect/#匯入時只描述在-apply-中取得)。套件最常違反的是下列幾條：

| 規則                                                                      | 避免的問題                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 發布 ESM，並讓外掛模組匯入的內容中不含 CommonJS 與原生附加元件相依。      | 進入點能到達的 CommonJS 或原生相依會讓熱重載回報 `Skipped` / `restart-required`（請參閱[重載不適用的情況](../../hot-reload/#重載不適用的情況)）。對這類相依，接受重新啟動，或在 [Remote](../../remote/overview/) 下執行外掛。 |
| 外掛模組中不要出現 `node:module` 和 `module`，連 `createRequire` 也不行。 | 這樣的匯入會讓整張圖[脫離熱重載](../../hot-reload/#重載不適用的情況)，直到行程重新啟動。                                                                                                                                      |
| 從 `config` 讀取設定，不要從 `process.env` 讀取。                         | 使用者無法在 `graft.yml` 中看到或設定這些值。[`--env-file` 的值](../../cli/#env-檔案)永遠不會進入 `process.env`，`loader.retry` 也不會重新讀取你讀的變數。                                                                    |

## 把設定和鍵當作公開 API

使用者會在 `graft.yml` 中寫你的設定欄位，並在
[`inject` 和 `isolate`](../../config-file/#規則)
中寫你的鍵字串，因此改動任何一者都會破壞他們的檔案。

| 寫法                                               | 效果                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| 以 `Schema.withDecodingDefaultKey` 提供預設值      | 設定項目可以省略這個欄位。                                                    |
| 機密寫成 `Schema.RedactedFromValue(Schema.String)` | 日誌會隱藏它的值，使用者可以用 [`!env`](../../config-file/#型別與機密) 傳入。 |
| 值可能來自 `!env` 時，使用能解碼字串的 schema      | `!env` 提供的是字串；例如 `Schema.NumberFromString` 會把它轉成數字。          |
| 可編碼為 JSON 的設定                               | 外掛就能在 [Remote](../../remote/overview/) 下執行。                          |

變更對既有設定項目的影響：

| 變更                          | 既有設定項目                                                        |
| ----------------------------- | ------------------------------------------------------------------- |
| 新增帶預設值的欄位            | 照常運作。                                                          |
| 新增必要欄位，或收緊檢查      | 以 `SchemaError` 失敗，並停在 `Failed`，直到它們的設定被修改。      |
| 移除欄位                      | 照常運作。解碼會直接捨棄未知欄位，不會報錯。                        |
| 重新命名欄位                  | 舊值被悄悄捨棄。如果新欄位有預設值，什麼都不會失敗。                |
| 變更服務、事件或 Reference 鍵 | 消費者和 `graft.yml` 中的鍵不再相符。必要的消費者會停在 `Pending`。 |

新增必要欄位、收緊檢查、重新命名或變更鍵，都應發布為新的主要版本，並在變更紀錄中說明使用者必須修改什麼。

## 選擇套件名稱

`graft.yml` 中的短名稱會找到名為 `graft-plugin-<name>` 的無 scope 套件：

| 套件                          | 使用者寫                                            |
| ----------------------------- | --------------------------------------------------- |
| `graft-plugin-postgres`       | `name: postgres` 或 `name: graft-plugin-postgres`   |
| 該套件的 `./migrations` 匯出  | `name: postgres/migrations`                         |
| `@acme/graft-plugin-postgres` | `name: "@acme/graft-plugin-postgres"`，寫出完整名稱 |

- 應用程式從自己的目錄解析[外掛名稱](../../config-file/#外掛名稱)，因此它必須相依於你的套件，例如透過
  `graft add` 加入。
- 短名稱會先照原樣嘗試，只有在某個候選不存在時，Graft 才會改試下一個。如果應用程式能解析到名為
  `postgres` 的套件（例如你的驅動程式），`name: postgres` 和
  `name: postgres/migrations` 都會以 `ModuleInvalid` 失敗。
- README 中的 `graft.yml` 範例請寫完整的套件名稱，它不會解析到別的套件。
- `graft add --plugin` 會保留以 `@` 或 `graft-plugin-`
  開頭的名稱，其他名稱則改寫成 `@graftland/plugin-<name>`。帶有 `./cli`
  匯出的套件，名稱必須是這兩種形式之一。

## 編輯器自動補全

`graft.yml`
的編輯器 Schema 對外掛設定不做限制。匯出一份登記項目，應用程式就能檢查你的設定項目：

```ts title="src/schema.ts"
import { JsonSchema, Schema } from "effect"

import { Config } from "./tokens.js"

export const entries = () => [
	{
		names: ["postgres", "graft-plugin-postgres"],
		schema: JsonSchema.toDocumentDraft07(
			Schema.toJsonSchemaDocument(Config, {
				referencePolicy: () => undefined,
				onExcessProperty: "error",
			}),
		).schema,
		required: true,
	},
]
```

| 欄位       | 規則                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names`    | 使用者可能為這個外掛寫的每個 `name`，包括短名稱和完整名稱。                                                                                                         |
| `schema`   | 設定 schema 的編碼端。`referencePolicy: () => undefined` 會把定義內嵌進來，否則它們會遺失。`onExcessProperty: "error"` 會標出未知欄位，否則解碼時它們會被悄悄丟棄。 |
| `required` | 設定有必要欄位時設為 `true`，這樣沒有 `config` 的設定項目會被標記出來。                                                                                             |

這裡只匯入識別物件模組：產生 Schema 時不得載入外掛。應用程式把這些登記項目傳給
`ConfigSchema.make`，請參閱[編輯器支援](../../config-file/#編輯器支援)。

## 支援的 Graft 版本

| 範圍                    | 規則                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@graftland/*` 對等相依 | Graft 還在 0.x 時，[任何版本都可能變更 API](../../releases/#發佈版本)。`^0.4.0` 只接受 0.4.x；測試過下一個次要版本後再放寬。               |
| `effect` 對等相依       | 使用你支援的 `@graftland/graft` 版本所宣告的範圍，例如 `4.1.*`。                                                                           |
| `devDependencies`       | 在對等相依範圍內指定確切版本，讓測試針對你聲稱支援的某個版本執行。                                                                         |
| 你自己的版本            | 如上所述，破壞性的設定或鍵變更就是新的主要版本。宿主可以用 [`connect.expect`](../../remote/runners/#實例) 要求 runner 上安裝你的特定版本。 |

## 在應用程式中試用套件

自動化測試請參閱[測試](../testing/)。若要以使用者的方式試用套件：

1. **打包**：執行 `npm pack`。
2. **建立**應用程式：使用
   [`graft create playground`](../../cli/#graft-create)。它已經相依於
   `@graftland/graft`、`@graftland/cli` 和 `effect`，滿足你的對等相依。
3. **安裝**打包出的 tarball：使用該應用程式的套件管理器。
4. **新增**設定項目：使用 README 中的名稱，然後執行 `graft start`。

:::caution

請安裝 tarball，不要使用連結的目錄。連結的套件會從自己的 `node_modules` 解析
`effect` 和 `@graftland/graft`，也就是你的 `devDependencies`
所在的位置，因此應用程式會各多出一份。

:::
