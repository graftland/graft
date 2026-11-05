---
title: 設定檔
description: 用 graft.yml 描述應用程式，並在執行期間修改設定。
---

`graft start` 會讀取一個 YAML 檔案，預設是
`graft.yml`。檔案內容是一份設定項目清單，每個項目載入一個外掛：

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL

- id: api
  name: ./plugins/api.mjs
  config:
    port: 8080

- id: tenants
  name: tenants
  group: true
  isolate:
    app/Database: true
  config:
    - id: tenant-db
      name: "@acme/graft-plugin-postgres"
      config:
        url: !env TENANT_DATABASE_URL
```

| 本頁內容                   | 請閱讀                            |
| -------------------------- | --------------------------------- |
| 設定項目的格式             | [設定項目欄位](#設定項目欄位)     |
| `name` 如何找到模組        | [外掛名稱](#外掛名稱)             |
| 來自環境的機密與設定       | [環境變數](#環境變數)             |
| 編輯器的自動補全與檢查     | [編輯器支援](#編輯器支援)         |
| 儲存檔案時會發生什麼       | [執行期間的變更](#執行期間的變更) |
| 從外掛或程式碼編輯設定項目 | [Loader API](../loader-api/)      |

設定項目也可以讓它的外掛在子行程、worker 或另一台機器上執行：寫上
`name: remote`，再把外掛的設定包一層，見
[從 YAML 載入](../remote/hosts/#從-yaml-載入)。它仍然是一般的設定項目，同樣有 id、`disabled`、`inject`、`isolate`，也能在執行期間編輯。儲存的項目 id 同時也是 runner 上的實例名稱。

從項目載入的外掛可從 `@graftland/loader` 匯入 `Entry`，讀取
`yield* Entry.CurrentId`。它是
`Context.Reference<Option<string>>`，值為目前項目的 id，巢狀 group 中也一樣；不經過項目載入時預設為
`None`。外掛內部 fork 的子外掛會繼承它，不會為每個 fork 產生新 id。Include 會把產生的 id 儲存到 YAML，供宿主重新啟動後繼續使用。

## 命令外掛

在最外層宣告命令外掛項目：

```yaml
- name: remote/cli
  cli: true
```

這些項目設定 CLI 命令，`graft start` 不會將它們載入應用程式樹中。 `config`
傳給命令外掛，`disabled: true` 停用項目。修改後重新執行命令即可生效。命令項目的
`!env` 讀取行程環境；`start --env-file` 和 `--env-dir` 只作用於應用程式項目。

| 來源     | 規則                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 專案     | 目前目錄的 `graft.yml`，不往父目錄尋找。                                             |
| 使用者   | `~/.graft/graft.yml`，套件安裝在 `~/.graft/node_modules`。                           |
| 覆寫目錄 | `GRAFT_HOME` 取代 `~/.graft`，同時改變設定與套件的目錄。                             |
| 合併     | `name` 完全相同時以專案項目為準，包含 `disabled`；其餘項目合併。命令名稱衝突時報錯。 |
| 專案之外 | 使用者命令仍可使用；不存在的設定檔視為空清單。                                       |
| 路徑     | 模組以宣告所在的設定檔目錄為準；外掛可透過 `ConfigDirectory` 解析設定中的路徑。      |

只有明確宣告的模組會執行，不掃描已安裝的相依套件。可用
[`graft add --plugin`](../cli/#graft-add) 一次完成安裝與啟用。

## 設定項目欄位

| 欄位        | 作用                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `id`        | 識別設定項目。如果項目沒有 `id`，Graft 會產生一個並寫回檔案。                   |
| `name`      | 外掛的模組，可以是相對路徑、套件名稱或短名稱。群組會忽略此欄位。                |
| `config`    | 外掛的輸入；對群組來說，則是其設定項目清單。                                    |
| `disabled`  | 設為 `true` 時會卸載該項目，但仍保留在檔案中。                                  |
| `group`     | 設為 `true` 時，該項目成為包含其他項目的群組。                                  |
| `inject`    | 載入外掛前需要等待的服務鍵，作為外掛自身 `inject` 宣告的補充。                  |
| `isolate`   | 需要[隔離](../isolation/)的鍵。`true` 表示私有領域（realm），標籤表示共用領域。 |
| `intercept` | 經過 Schema 驗證、針對已登記 Reference 的修補內容，對該項目及其所有後代生效。   |

### 規則

| 規則             | 說明                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **ID 唯一**      | ID 在整個 Loader/Include 樹中必須唯一，包括已停用的項目。直接嵌入的 `Group.Group` 實例只要求同層項目之間唯一。               |
| **每一層都相同** | 每一層巢狀的設定項目，欄位的解碼方式都相同。                                                                                 |
| **額外欄位**     | `note` 這類額外欄位會當作中繼資料保留，透過 API 編輯時也是如此；它們不會繞過對已宣告欄位的驗證。                             |
| **空群組**       | 沒有 `config` 的群組是空群組（`config: []`）。群組的 `config` 不能明確設為 `null`。                                          |
| **鍵**           | 服務鍵和 Reference 鍵就是建立它們時使用的字串。例如 `Context.Service<...>()("app/Database")` 對應的服務鍵是 `app/Database`。 |

### 跨編輯保留身分

如果重新寫入一棵匿名樹，而內容沒有變化，它會保留已分配的 ID 和執行中的外掛實例。

1. 載入器還原子項目的 ID。
2. 比對匿名的父群組。
3. 把 ID 寫回 YAML。

匿名項目先依名稱和保守的設定指紋篩選，再精確比較；重複的符合項目保持原順序。

:::tip

若需要在設定變更之間保持身分，或相同項目被重新排列而難以區分，請明確指定 ID。

:::

### 設定檔中的 intercept

設定檔中的 intercept 只接受[明確登記的 Reference](../intercepts/#設定檔-intercept)。`graft start`
登記了兩個：

| Reference 鍵                              | 設定的值                                                            | 行為                                   |
| ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------- |
| `effect/References/CurrentLogAnnotations` | 物件                                                                | 與外層註解淺層合併；設定的鍵優先。     |
| `effect/References/MinimumLogLevel`       | `All`、`Fatal`、`Error`、`Warn`、`Info`、`Debug`、`Trace` 或 `None` | 取代外層的最低日誌層級。值區分大小寫。 |

```yaml title="graft.yml"
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

此項目及其子外掛會繼承這些註解和日誌層級，同層項目保留各自的設定。在這裡，`Info`、`Debug`
和 `Trace` 日誌會被過濾掉；`All` 允許所有層級，`None` 則關閉所有日誌。

| 問題       | 錯誤                    |
| ---------- | ----------------------- |
| 鍵尚未登記 | `UnregisteredReference` |
| 值無效     | `InvalidIntercept`      |

嵌入載入器時，除非宿主應用程式在啟動時提供，否則登記表是空的。

## 外掛名稱

`name` 的解析方式：

| `name` 的樣式           | 含義                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| 以 `.` 開頭             | 相對於設定檔的路徑。                                                          |
| 以 `/` 開頭             | 絕對路徑。                                                                    |
| 以 `@` 開頭，或包含 `:` | 原樣使用。                                                                    |
| 其他（例如 `review`）   | 先照原樣嘗試，再試 `@graftland/plugin-<name>`，最後試 `graft-plugin-<name>`。 |

套件從應用程式目錄解析。例如，`name: remote` 會找到
`@graftland/plugin-remote`，`name: remote/runner` 會找到它的 `runner` 匯出。

### 模組無法載入時

如果找不到外掛，或其模組匯入失敗，該項目仍會以失敗 fork 的形式出現在 fork 樹中，並附上錯誤。項目變更，或[熱重載](../hot-reload/)取得新程式碼時，Graft 會再次嘗試。

### 項目的生命週期

每個已啟用的項目，在其模組開始解析之前，就會先取得一個生命週期 fork。

| 情況                       | 行為                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ |
| 匯入仍在進行               | 視為 `Loading`。`ready` 會繼續等待，但健康的同層項目和之後的編輯可以繼續進行。 |
| 項目被移除、停用或取代     | 其生命週期被取消，解析器的資源被釋放。                                         |
| 解析期間設定變更           | 開始新的嘗試。未變更的項目保留目前的嘗試。                                     |
| 已取消的匯入較晚才回傳結果 | 不能再次啟用舊項目。原生的匯入 promise 本身仍可能執行模組程式碼。              |
| 解析成功                   | 生命週期將真正的外掛建立為子 fork。`ready` 會檢查整個子樹。                    |

仍在等待的服務注入和已失敗的 fork 同樣視為已完成。

Effect 匯入器會為每個候選模組在獨立的 scope 中取得資源：

- 失敗的候選項目會在嘗試下一個名稱之前釋放。
- 清理失敗會阻止後備嘗試，並與匯入失敗一併保留。
- 成功的候選項目的資源仍由項目的生命週期擁有。

## 環境變數

`!env NAME` 會在載入項目時讀取環境變數。

- 檔案保留該標籤，因此機密不會寫入檔案。
- 如果變數未設定，該項目會一直失敗，直到你修正為止。
- `graft start --env-file .env` 也會從 `.env`
  檔案讀取變數；行程環境優先。`--env-dir`
  以相同方式讀取掛載的機密檔案。請參閱[命令列](../cli/#graft-start)。

### 型別與機密

`!env`
提供的是字串，由外掛的設定 Schema 決定它變成什麼。選擇讀取哪個變數的是撰寫設定檔的人；外掛只描述它需要的值。

| Schema                                    | 結果               |
| ----------------------------------------- | ------------------ |
| `Schema.NumberFromString`                 | 數字。             |
| `Schema.RedactedFromValue(Schema.String)` | 日誌會隱藏的機密。 |

如果外掛想使用 Effect 的 `Config` 工具（例如預設值和後備值），可以在 `apply`
內用它們讀取自己的輸入：

```ts import.meta.vitest name="config-file: read the input with Config"
import { Config, ConfigProvider, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

const readSettings = (input: unknown) =>
	Settings.parse(ConfigProvider.fromUnknown(input))

export default Plugin.make({
	name: "server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* readSettings(input)
			yield* Effect.log(`Listening on port ${settings.port}`)
		}),
})

Effect.runSync(readSettings({ port: "3000" })) // => { port: 3000 }
Effect.runSync(readSettings({})) // => { port: 8080 }
```

外掛的 Schema 仍然描述該項目接受什麼。外掛自行從環境提供者讀取的 `Config` 值不是
`!env` 標籤，因此 `retry` 不知道它們，也不會重新載入。

### 標籤適用的位置

- 一般外掛的 `config` 和 `intercept` 值中，包括巢狀的陣列和記錄。
- 項目先解析自己的 intercept，再由已登記的 Schema 解碼並合併，解析後的值仍須通過該 Schema。
- 群組只解析自己的 intercept，不解析後代的描述，也不會提前解析子項目的變數。
- 已停用的項目不會解析變數。
- 如果某個啟用中的子項目缺少變數，只有該子項目失敗，所屬群組和同層項目不受影響。
- 儲存的目標和檔案都保留原始標籤。

### 何時重新讀取值

| 觸發條件                                        | 哪些項目會重新讀取變數                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| 一般的 API 編輯或 YAML 變更                     | 只有變更的項目。未變更的健康同層項目和子樹保留原有的值。 |
| `loader.retry` 或 `loader.root.update(entries)` | 整棵樹，包括巢狀群組和注入閘門。                         |

明確重新整理之後：

- 解析後設定有變更的執行中項目，會透過 `update` 取得新設定。
- 解析後 intercept 有變更的項目會重新載入。
- 值沒有變更的項目繼續執行。
- 仍在匯入的項目會在匯入結束時讀取環境。如果重試時項目仍在載入，會在它啟用後再讀取一次。
- `ready` 也會等待這些已排隊和執行中的重新整理，所以在明確重新整理並 `ready`
  之後，每個啟用中的項目都持有目前的值。

### 環

陣列和一般記錄可以共用設定值，但不能包含環。

| 環出現的位置           | 結果                                                         |
| ---------------------- | ------------------------------------------------------------ |
| 在 config 或 intercept | 該項目以 `CyclicConfig` 失敗。同層項目和之後的編輯可以繼續。 |
| 在項目／群組結構中     | 在分配 ID 和載入之前，以 `InvalidOperation` 拒絕。           |

環境變數解析把其他類別實例視為不透明值。

## 編輯器支援

每個 Graft 版本都附帶這份檔案的 JSON
Schema，版本號與該版本相同。在第一行用註解把 YAML language server 指向它，VS
Code（搭配 YAML 擴充功能）等編輯器就能自動補全並檢查設定項目欄位：

```yaml title="graft.yml"
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json
- id: api
  name: ./plugins/api.mjs
```

- 請把 `1.2.3` 換成專案中 `@graftland/cli`
  的版本，並在升級 Graft 時一併更新。`graft create` 會以自己的版本寫入這一行。
- Schema 也包含在套件中，路徑為 `@graftland/cli/schema.json`。
- 它檢查設定項目欄位、已登記的 intercept，以及 `remote`、`remote/runner` 與
  `remote/cli`
  的設定，包括 group 內的項目。業務設定與自訂能力的設定保持開放，在啟動時由各自的 schema 檢查。

要產生應用程式自己的編輯器 Schema，用 `@graftland/loader` 的 `ConfigSchema.make`
組合明確登記的外掛設定。Remote 透過 `@graftland/plugin-remote/Config`
發布自己的登記項目。產生 Schema 不會載入外掛。

language server 可能會標記 `!env`。請在編輯器設定中宣告這個標籤。以 VS
Code 為例：

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## 執行期間的變更

使用 `graft start --watch`
時，Graft 會監看設定檔。Include 會合併來自項目監看器和實體目標監看器的通知，並在 100
ms 內沒有新通知後才重新整理。安裝監看器時仍會要求補讀一次，包括符號連結的目標變更之後。

接著 Graft 會比較新項目與執行中的項目：

| 變更                                                     | 結果                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `config` 變更                                            | 透過 [`update`](../fork-handle/) 傳入新輸入。外掛原地更新或重新啟動。 |
| `name`、`group`、`inject`、`isolate` 或 `intercept` 變更 | 卸載後重新載入。                                                      |
| 新增項目                                                 | 載入。                                                                |
| 項目被移除或停用                                         | 卸載。                                                                |
| 未變更的健康項目                                         | 繼續執行，保留既有的環境變數值。                                      |
| 已協調群組中的失敗項目                                   | 重試。仍在進行且未變更的解析會保留其啟用狀態。                        |

### 並行

- 彼此獨立的同層更新和移除會並行執行。
- 每個項目的工作仍然序列化，取代時會等待該項目舊實例的清理完成。
- 群組會等待所有必要的工作完成，才接受目標。
- 延遲的環境重新整理與一般編輯共用群組的序列協調執行器。它們不能中斷更新回呼來套用更新的目標。
- 針對已移除或已被取代的項目世代的請求會被丟棄。

### 清理失敗

如果 Graft 在移除、停用或取代項目時清理失敗，會記錄附有項目和 fork 識別碼的完整 cause，然後繼續協調。

- 被移除的 fork 會被釋放。取代者有自己獨立的生命週期。
- 如果保留的 fork 重新啟動失敗，該失敗會以 `Failed` 的狀態保持可見，你可以重試。
- 解析器觀察資源的失敗和生命週期清理的失敗會一併記錄，不會重新啟動健康的同層項目。
- `ready` 將失敗的 fork 視為已完成，但不保證清理成功。

### 無效的檔案

| 情況                             | 行為                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| 執行中檔案無效                   | Graft 記錄錯誤，並保留最後一個有效的版本。                                     |
| 首次檔案無效，且使用 `--watch`   | Graft 記錄 cause，以沒有項目的狀態啟動並持續監看。修正檔案後會載入其中的項目。 |
| 首次檔案無效，且未使用 `--watch` | 啟動失敗。                                                                     |
| 檔案無效時進行 API 編輯          | 不能用空的設定取代無效的檔案。                                                 |

使用 `initial`
嵌入 Include 時，只有在 YAML 準備、ID 分配、整棵樹驗證和序列化驗證都成功後，才會建立不存在的檔案，並一次提交完整的文件。無效的初始項目會讓檔案保持不存在，而已存在的檔案優先於
`initial`。

## 符號連結

Include 會保留符號連結。每次磁碟操作都會解析設定的路徑，並將該實際目標與內容快照一起保存。讀取、衝突檢查、自動 ID 寫入和 API 編輯都使用同一個目標；暫存檔建立在該目標所在的目錄中。

| 情況                         | 行為                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 連結在 rename 之前變更       | 丟棄暫存檔，並依有上限的重試與同欄位衝突規則重新基於新內容套用編輯。                       |
| 監看模式                     | Include 同時監看項目所在的目錄和目前目標所在的目錄。                                       |
| 項目的連結變更               | 重新讀取，目標監看器隨之切換：釋放舊的，新的就緒後再要求讀取一次。                         |
| 新目標的 YAML 無效           | 保留最後一個有效的執行期目標；修正檔案後即可恢復。                                         |
| 未監看                       | 下一次 API 編輯會讀取新的指向目標。                                                        |
| 位於被監看目錄之外的中間連結 | 下一次讀取時會跟隨，但它們本身不會產生通知。                                               |
| 不存在的一般檔案             | 可以初始化。                                                                               |
| 懸空、循環或無法存取的連結   | 有型別的檔案系統錯誤，絕不會被一般檔案取代。請修復指向目標；API 編輯或項目通知會再次嘗試。 |

:::caution

解析路徑和 rename 是兩個獨立的檔案系統操作。最終檢查之後才變更的連結，可能讓進行中的編輯提交到舊目標；下一次讀取會跟隨新目標。這與
[Loader API](../loader-api/#並行儲存)
中的並行儲存是同一個視窗。它不是多檔案交易。

:::
