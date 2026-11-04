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

要讓設定項目在子行程或另一台機器上執行，可將它指向[遠端外掛入口](../remote/host/)；儲存的項目 id 也可以作為 runner 實例名稱。

從項目載入的外掛可從 `@graftland/loader` 匯入 `Entry`，讀取
`yield* Entry.CurrentId`。它是
`Context.Reference<Option<string>>`，值為目前項目的 id，巢狀 group 中也一樣；不經過項目載入時預設為
`None`。外掛內部 fork 的子外掛會繼承它，不會為每個 fork 產生新 id。Include 會把產生的 id 儲存到 YAML，供宿主重新啟動後繼續使用。

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

每一層巢狀的設定項目，解碼方式都相同。`note`
這類額外欄位會當作中繼資料保留，透過 API 編輯時也是如此；它們不會繞過對已宣告欄位的驗證。沒有
`config` 的群組是空群組（`config: []`）。群組的 `config` 不能明確設為 `null`。

載入器會為每個已接受的目標保留一份凍結快照。在 API 編輯進入佇列之前，載入器會複製陣列和一般物件（包括中繼資料）。接受初始目標或重新整理後的目標時，也會複製它們。之後修改你傳入的物件，不會改變執行中的目標或已儲存的目標；要套用新值，請再提交一次編輯。`loader.entries`
和 `loader.changes` 提供的資料是凍結的。

嵌入載入器時，類別實例會保留原本的參照。例如 `Env`、其他 Data 類別、`Date`
和其他不透明值。載入器不會複製或凍結它們的內部資料，所以請把它們當作不可變的設定來使用。陣列和一般物件可以共用參照，快照會保留這種共用。環也會保留在快照中，但環仍會在既有的項目或樹狀結構邊界上驗證失敗。環境變數解析會保留共用的陣列和一般記錄，不會把它們展開成樹。它的身分快取只屬於單次執行，所以之後的啟用或更新會重新讀取環境變數。快照複製、環偵測和設定比較也都能處理共用圖；比較時，每對一般容器只會走訪一次。不透明值沿用 Effect 的相等性，包括自訂的相等性實作。

如果重新寫入一棵匿名樹，而內容沒有變化，它會保留已分配的 ID 和執行中的外掛實例。載入器會先還原子項目的 ID，再比對匿名的父群組，然後把 ID 寫回 YAML。若需要在設定變更之間保持身分，或相同項目被重新排列而難以區分，請明確指定 ID。

服務鍵和 Reference 鍵就是建立它們時使用的字串。例如
`Context.Service<...>()("app/Database")` 對應的服務鍵是 `app/Database`。

設定檔中的 intercept 只接受[明確登記的 Reference](../isolation/#設定檔中的-intercept)。每筆登記包含三樣東西：Reference 物件、設定修補內容的 Schema，以及具型別的合併函式。載入器先解碼修補內容，再與外層的值合併；如果沒有外層覆寫值，則與 Reference 的預設值合併。是否合併物件，由登記時的合併函式決定，不會自動進行。

未登記的鍵會讓該項目以 `UnregisteredReference` 失敗。輸入無效時會以
`InvalidIntercept` 失敗，Schema 錯誤會保留為其 cause。外掛的 `apply`
不會執行。嵌入載入器時，登記表預設是空的，除非宿主應用程式在啟動時提供。`graft start`
提供以下兩筆登記：

| Reference 鍵                              | 設定值                                                              | 行為                                         |
| ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `effect/References/CurrentLogAnnotations` | 物件                                                                | 與外層日誌註解淺層合併，同名鍵以設定值為準。 |
| `effect/References/MinimumLogLevel`       | `All`、`Fatal`、`Error`、`Warn`、`Info`、`Debug`、`Trace` 或 `None` | 取代外層的最低日誌層級，區分大小寫。         |

```yaml title="graft.yml"
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

此項目及其子外掛會繼承日誌註解和日誌層級，同層的其他項目保有各自的設定。在這個範例中，`Info`、`Debug`
和 `Trace` 日誌會被過濾掉。`All` 允許所有層級，`None`
會關閉所有日誌。其他 Reference 需要由自訂宿主明確登記。

## 外掛名稱

以 `.` 開頭的 `name` 是相對於設定檔的路徑，以 `/` 開頭的是絕對路徑。以 `@`
開頭或包含 `:`
的名稱會直接使用。其他名稱會依序嘗試原名稱、`@graftland/plugin-<name>` 和
`graft-plugin-<name>`。套件從應用程式目錄解析。

如果找不到外掛，或模組匯入失敗，該項目仍會出現在 fork 樹中，顯示為帶有錯誤的失敗 fork。當項目變更，或[熱重載](../hot-reload/)取得新程式碼時，Graft 會再次嘗試載入。

每個啟用的項目，都會在模組開始解析之前先建立一個生命週期 fork。尚未完成的匯入算作
`Loading`，因此 `ready`
會繼續等待，但正常的同層項目和之後的編輯仍可繼續進行。移除、停用或取代該項目時，會取消它的生命週期並釋放解析器資源。解析期間修改設定，會開始新一輪嘗試；沒有變更的項目沿用目前的嘗試。已取消匯入的遲到結果，不會再次啟用舊項目。原生的 import
Promise 本身仍可能繼續執行模組程式碼。

解析成功後，生命週期會把實際的外掛建立為子 fork。`ready`
會檢查整棵子樹，所以處於啟用狀態的生命週期不會掩蓋仍在載入的外掛。等待服務注入的 Pending
fork 和 Failed fork 仍視為已穩定。

## 環境變數

`!env NAME`
會在載入項目時讀取環境變數。檔案中保留的是標籤，所以機密資料不會被寫進檔案。如果變數沒有設定，該項目會失敗，直到問題修正為止。

`!env`
得到的是字串。它最後變成什麼，由外掛的設定 Schema 決定。`Schema.NumberFromString`
這類 Schema 會把它轉成數字，`Schema.RedactedFromValue(Schema.String)`
會包裝機密資料，讓日誌不顯示原文。要讀取哪個變數，由撰寫設定檔的人決定；外掛只描述它需要的值。

`graft start --env-file .env` 也會從 `.env`
檔案讀取變數。行程環境變數優先。詳見[命令列](../cli/#graft-start)。

`loader.retry` 會重新讀取 `!env`
的值。執行中的項目如果解析後的 config 有變，會透過 `update`
收到新的 config；解析後的 intercept 有變，則會重新載入該項目；值沒有變化的項目會繼續執行。仍在匯入模組的項目，會在匯入結束後讀取環境變數。如果重試時項目仍在載入，會在其啟用後立即取得最新的值。

如果外掛想使用 Effect 的 `Config` 工具（例如預設值和備選來源），可以在 `apply`
裡用它們讀取自己的輸入：

```ts
const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

export default Plugin.make({
	name: "server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* Settings.parse(ConfigProvider.fromUnknown(input))
			// ...
		}),
})
```

外掛的 Schema 仍然描述項目接受什麼。如果外掛自行從環境中的 provider 讀取
`Config` 值，這些值不是 `!env` 標籤。`retry` 不知道它們，也不會重新載入它們。

標籤可用於一般外掛的 `config` 和 `intercept`
值，包括巢狀的陣列和記錄。項目會先解析自己的 intercept，再由已登記的 Schema 解碼並合併；解析後的值仍須通過該 Schema。群組只解析自己的 intercept，不解析後代的描述。已儲存的目標和檔案都保留原始標籤。

群組會保留子項目的描述，不會提前解析它們的環境變數。停用的項目不解析變數。如果啟用的子項目缺少變數，只有該子項目失敗，不影響它所屬的群組和同層項目。

陣列和一般記錄可以共用設定值，但不能含有環。含有環的 config 或 intercept 會讓該項目以
`CyclicConfig`
失敗，同層項目和之後的編輯仍可繼續。環境變數解析將其他類別實例視為不透明值。項目與群組的結構本身出現環時，會在分配 ID 和載入之前，以
`InvalidOperation` 拒絕。

## 編輯器支援

每個 Graft 版本都附帶這個檔案的 JSON
Schema，版本號與該版本相同。在檔案第一行加上註解，把 YAML language
server 指向它，VS
Code（安裝了 YAML 擴充套件）等編輯器就能補全並檢查設定項目欄位：

```yaml title="graft.yml"
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json
- id: api
  name: ./plugins/api.mjs
```

請把 `1.2.3` 換成專案中 `@graftland/cli`
的版本，升級 Graft 時一併更新。`graft create`
會用自己的版本寫入這一行。這個 schema 也包含在套件中，路徑為
`@graftland/cli/schema.json`。

Schema 會檢查設定項目欄位，以及 `graft start` 登記的 intercept。它不檢查外掛的
`config`，因為只有外掛自己的 Schema 知道它的結構。language server 可能會把
`!env` 標為錯誤。要避免這點，請在編輯器設定中宣告這個標籤，以 VS Code 為例：

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## 執行期間修改設定

使用 `graft start --watch`
時，Graft 會監看設定檔。儲存後，Graft 會比較新的項目與正在執行的項目：

- `config` 有變的項目，會透過 [`update`](../lifecycle/#fork-控制代碼)
  收到新輸入，外掛會就地更新或重新啟動。
- `name`、`group`、`inject`、`isolate` 或 `intercept`
  有變的項目，會先卸載再重新載入。
- 新增的項目會被載入，移除或停用的項目會被卸載。
- 沒有變化的項目繼續執行。

移除、停用或取代項目時，如果清理失敗，Graft 會記錄完整的 cause 以及項目和 fork 的識別碼，然後繼續協調。被移除的 fork 已處置，取代項目有自己獨立的生命週期。仍保留的 fork 重新啟動失敗時，失敗會以
`Failed` 狀態保持可見，可以重試。`ready`
將失敗的 fork 視為已穩定，並不保證清理成功。

這也包括 resolver 觀察資源的清理：它與生命週期清理的失敗一併記錄，不重啟健康兄弟。延遲環境刷新與一般編輯使用 group 的同一個串行協調執行器，不會為了套用更新的目標而中斷 update 回呼。已移除或過時代次的刷新請求會被捨棄；`ready`
會等待尚未完成的刷新。

如果檔案內容無效，Graft 會記錄錯誤，並繼續執行上一個有效的版本。在監看模式下，即使初始檔案無效，Graft 也會記錄 cause，並以沒有任何項目的狀態啟動，同時繼續監看。修正檔案後，項目會自動載入。API 編輯不能把無效的檔案覆蓋成空設定。不使用監看模式時，初始設定無效會導致啟動失敗。

## 透過程式碼編輯設定項目

載入器會發布一個 `Loader` 服務，外掛可以注入它來讀取和編輯設定項目：

```ts
import { Loader } from "@graftland/loader"

const admin = Plugin.make({
	name: "admin",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			const id = yield* loader.create({ name: "./plugins/cron.mjs" })
			yield* loader.update(id, { config: { every: "5 minutes" } })
			yield* loader.update("api", { disabled: true })
		}),
})
```

| 成員                      | 作用                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| `entries`                 | 最新的已持久化目標項目。                                                          |
| `changes`                 | 目前已持久化的目標，加上之後接受的目標，不代表執行樹已協調完成。                  |
| `create(entry, options?)` | 新增項目，加在根清單的末尾，或加在 `parent` 群組的 `position` 位置，並傳回其 id。 |
| `update(id, patch)`       | 修改項目的部分欄位。                                                              |
| `remove(id)`              | 移除項目。                                                                        |
| `ready`                   | 等待目前的目標協調完成，且沒有任何 fork 處於 Loading。                            |
| `retry`                   | 要求再協調一次，以重試所有失敗的項目，並重新讀取 `!env` 的值。                    |

編輯結果會寫回檔案。Graft 會保留檔案中的註解、格式和 `!env`
標籤，並且先寫入暫存檔，所以設定檔不會只寫到一半。

Graft 在同一個目錄中建立暫存檔，建立時是獨占的，權限為
`0600`。Graft 會保留目標檔案的權限位元，以及讀得到的 uid/gid。接著對檔案執行 fsync 並關閉，再用 rename 換入。新檔案預設為
`0600`。如果寫入失敗或被中斷，Graft 會刪除暫存檔。如果這次清理也失敗，清理失敗的 cause 會和原始 cause 一起保留。不會複製擴充 ACL 和擴充屬性。也不會對目錄執行 fsync，所以 Graft 不保證 rename 在斷電後仍然存在。

編輯修改或刪除 YAML
anchor 之前，受影響的 alias 會變成各自獨立、保留原值的副本；其他 alias 維持不變。透過 alias 編輯群組中的子項目時，Graft 會先建立本地副本，來源集合不會改變。寫入之前，Graft 會解碼最終文件，並對照目標進行檢查。如果解析或序列化失敗，Graft 會傳回帶有原始 cause 的
`StoreError`，檔案維持不變。

項目與群組結構邊界上的 alias，會在收集和分配 ID 之前實體化，所以 alias 群組中的匿名子項目也會取得各自的 ID。來源範本以及一般外掛設定中無關的 alias 維持不變。自動分配 ID 時，Graft 會先計算一個獨立的邏輯目標。插入 ID 之前，受這些插入影響的 alias 會以原值實體化，所以一般外掛設定不會繼承產生的 ID。寫入之前，Graft 會解析序列化後的 YAML，並對照計畫中的目標進行檢查；如果兩者不一致，會傳回
`StoreError`，檔案維持不變。

編輯進入載入器有界的工作佇列時，才算被接受。在接受之前取消呼叫端，編輯不會生效。接受之後，取消只會停止等待；載入器 scope 中的 worker 會繼續完成儲存檔案和發布目標。每個呼叫端透過 Deferred 取得該次操作的結果。即使呼叫端已經離開，失敗仍會記錄完整的 cause。關閉載入器會停止 worker、結清等待中的呼叫端，並以
`LoaderClosed` 拒絕新的編輯。

執行樹的協調在獨立的 scoped
fiber 中進行，可能會跳過中間的目標版本。編輯完成表示它的目標已儲存並發布，並不表示外掛已經更新完成。在生命週期回呼之外，使用
`ready` 等待目前的目標及其載入中的 fork。回呼可以提交編輯，但不能等待
`ready`，否則會等待回呼自己。`retry` 再次發布未變更的目標時，`changes`
也會發出一次通知。`retry`
會穿過生命週期、注入和群組的包裝層，到達失敗的外掛，並重新啟動失敗的外掛 fork；健康的實例和尚未完成的解析維持不變。一般的目標協調也會重試失敗的項目。`retry`
在發布請求之後就會傳回；要等待協調完成，請在生命週期回呼之外接著呼叫 `ready`。

如果自 Graft 上次讀取之後，有人修改過檔案，Graft 會先重新讀取檔案，再套用編輯。假如編輯修改的欄位，也在檔案中被修改過，就以檔案為準：Graft 會放棄這次編輯並記錄一則警告。

在 rename 已準備好的暫存檔之前，Graft 也會檢查目的地檔案的內容。如果檔案已變更，Graft 會捨棄暫存檔、讀取新版本，並重新套用編輯。同一欄位的衝突規則仍以最初的快照為基準，所以準備期間發生的修改也會被偵測到。最多嘗試三次；如果檔案持續變動，Graft 會傳回
`StoreError`，不提交這次 API 編輯。清理失敗會停止重試並保留完整的 cause。建立初始檔案和自動分配 ID 時，也使用同樣的檢查。

**並行儲存的限制：**
內容檢查和 rename 是兩個獨立的檔案系統操作。外部編輯器可能在兩者之間儲存，這次儲存仍可能被覆蓋。原子替換可以避免檔案只寫到一半，但它不是與任意編輯器之間的交易。如果無法接受這個剩餘的風險，請避免同時用編輯器儲存檔案和透過 API 寫入。

`ready` 將 `Pending` 和 `Failed`
的 fork 視為已穩定。服務提供者啟動後，外掛仍可能短暫處於 `Pending` 狀態。所以
`ready` 並不保證每個外掛都已啟用。
