# @graftland/loader

[English](https://github.com/graftland/graft/blob/main/packages/loader/README.md)
|
[简体中文](https://github.com/graftland/graft/blob/main/packages/loader/README.zh-CN.md)
| 繁體中文

從項目清單或 YAML 設定檔載入外掛。

支援的最低 Node.js 版本是 22.19。

```sh
npm install @graftland/loader effect
```

- `Include` 把項目保存在 YAML 檔案中，並把編輯寫回該檔案。
- `Loader` 在執行時編輯項目。
- `ModuleResolver` 把項目名稱轉換為外掛。

從項目載入的外掛可從 `@graftland/loader` 匯入 `Entry`，讀取
`yield* Entry.CurrentId`。它是
`Context.Reference<Option<string>>`，值為目前項目的 id，巢狀 group 中也一樣；不經過項目載入時預設為
`None`。外掛內部 fork 的子外掛會繼承它，不會為每個 fork 產生新 id。Include 會把產生的 id 儲存到 YAML，供宿主重新啟動後繼續使用。

## 自訂儲存

自訂儲存需要實作 `Loader.Store`：

- `initial` 提供起始項目。
- `apply(op)` 儲存一次 API 編輯。
- `external: Stream<void>` 表示某些內容可能已經變化。
- `refresh` 讀取最新狀態。

`refresh` 在快照有變化時回傳 `Option.some(entries)`，沒有變化時回傳
`Option.none()`。通知串流不得讀取或修改儲存的快照。

Loader 在同一把鎖下執行 `apply` 和
`refresh`，並在釋放鎖之前發布它們儲存的目標。所以儲存不需要額外的鎖。

對儲存實作的規則：

- 只有在操作成功之後，才提交新的快照。
- 讓可變的解析器物件保持在該操作內部。

Loader 如何處理失敗：

- 失敗的 refresh 會連同完整的 cause 一起記錄日誌。Loader 保留上一次成功的目標，並繼續處理之後的通知。
- 呼叫 `apply` 和存取 `refresh`
  都被延遲到受保護的操作內部執行。同步擲出的錯誤會被回報為 defect，不會讓回覆懸空，也不會停止之後的編輯。
- 存取 `external`
  被延遲到它的串流失敗邊界內部。出現 defect 時，通知會停止並記錄日誌，API 編輯仍然可用。
- 模組候選項的後備，要求恰好有一個失敗，並且該失敗表明候選項不存在。如果同時出現清理失敗、defect 或中斷，就不會使用後備，並保留完整的 Cause。
- Resolver 和 intercept 回呼在項目啟用內部執行。意外的同步擲出會使該項目失敗，並保留原始 cause。

## API 編輯

API 編輯使用有界佇列。佇列由 loader 的 scope 持有。

- 成功進入佇列就是准入。
- 在准入之前取消，沒有任何效果。
- 在准入之後取消，只是停止等待結果。

Worker 在同一把鎖下完成儲存和目標發布，並透過 `Deferred` 交付它的
`Exit`。失敗也會連同完整的 cause 一起記錄日誌，即使呼叫端已經不再等待。

關閉 loader 會做三件事：

- 停止 worker。
- 結束所有待處理的呼叫端。
- 用 `LoaderClosed` 拒絕新的編輯。

## 對帳

一個獨立的、帶 scope 的 fiber 把最新的目標與正在執行的樹對帳。它可能跳過中間的目標，但絕不會為了套用較新的目標而中斷正在執行的 update 回呼。

每個 group 由一個歸 scope 所有的協調執行器處理更新。延遲環境刷新 fiber 只提交請求，不直接呼叫
`Fork.update`。請求攜帶項目實例身分與協調代次；已移除、已取代或已被新代次取代的請求會被捨棄。`ready`
也會等待排隊和執行中的環境刷新。

`entries` 和 `changes`
描述的是已儲存的目標，而不是已完成的執行期更新。編輯在儲存和發布之後回傳。

`retry`
會再次發布目前的目標，以重試每一個失敗的項目，包括模組解析、設定準備和實際的外掛啟用。它還會做這些事：

- 重新讀取 `!env` 的值。
- 啟用中的項目透過 `update` 收到變化後的設定。
- 變化後的 intercept 會讓項目重新載入。
- 失敗的外掛 fork 會重新啟動，即使它們位於注入包裝器或 group 包裝器之下。
- 健康的實例和未完成的解析保持原樣。

一般 API 編輯與檔案變更只對變更的項目進行差量對帳；未變的健康兄弟與子樹保留目前環境值。編輯單一葉節點不再隱式刷新整棵樹。參與對帳的群組仍會重試失敗項目，並保留未完成的解析。需要整棵樹重新讀取環境時，明確呼叫
`retry` 或 `loader.root.update(entries)`；刷新會穿過巢狀群組與注入包裝器。

獨立兄弟的更新與移除清理並行執行；同一項目的操作仍循序，替代實例須等待舊實例清理結束，群組也會等待本輪必要工作全部完成。Include 合併入口與實際目標的通知，在連續 100ms 沒有新通知後刷新；監聽安裝後的補讀與符號連結目標切換仍保留。

`ready` 會一直等到目前的目標版本已經對帳完畢，並且沒有 fork 處於
`Loading`。`Pending` 和 `Failed`
都算作已穩定。生命週期回呼可以提交編輯，但不得等待
`ready`，因為那樣會等待它們自己。

## 項目生命週期

每個啟用的項目會立即得到一個生命週期 fork。模組解析和設定準備在該 fork 的啟用中執行。所以緩慢的 import 會停留在
`Loading`，不會阻塞它的同層項目，也不會阻塞之後的目標對帳。

移除、停用或取代項目，會關閉該生命週期及其 resolver 資源。它的載入狀態隨後不再計入
`ready`。

- 解析期間的設定變化會取消目前的嘗試，並用最新的輸入開始新的嘗試。
- 無關的編輯不會影響未變化的解析，它會繼續執行。

移除、停用或取代期間的清理失敗，會連同完整的 cause 以及項目和 fork 的識別碼一起記錄日誌。對帳會用目標的其餘部分繼續進行。

項目處置會收集生命週期與 resolver observation scope 兩階段的清理結果，統一回報為
`CleanupError`。兩階段同時失敗時保留雙方完整 Cause，不重啟健康兄弟。呼叫端中斷仍以中斷傳播，不轉換成項目清理錯誤。

- 被移除的 fork 會被釋放，不會作為失敗的項目留在樹中。
- 取代項會得到自己的生命週期。
- 如果 core 在保留的 fork 上回報重新啟動失敗，該 fork 會保持明顯的失敗狀態，`retry`
  可以重新啟動它。
- `ready` 表示已穩定，不表示清理成功。

解析成功之後，生命週期把實際的外掛作為子 fork 持有。如果要求了注入等待，它還會持有一個等待注入的 fork。所以 fork 樹包含這一層生命週期。

`ready` 會檢查每一個後代，包括在其生命週期變為 `Active` 之後仍在載入的外掛。

結果的發布由 core 的啟用 scope 和 supervisor
generation 負責。所以被取消的 import 之後不能在已移除或已取代的項目下建立外掛。原生 import 的 promise 可能會繼續執行模組程式碼，但它們遲到的結果不會被啟用。

## 樹的驗證與中繼資料

`Tree.validate`
先檢查項目樹的結構是否有環，然後解碼整棵樹。檔案讀取、編輯、寫回驗證，以及 Loader 接受的目標，都使用同一個邊界。

- 未知的項目欄位（例如 `note`）會在每一層都作為中繼資料保留。
- 已宣告的欄位仍然要通過 Schema 驗證。
- `Entry.Entry` 把這些額外欄位包含進來，型別為 `unknown`。
- `create` 和 `update` 接受中繼資料，並保持已知欄位的型別。
- 沒有 `config` 的 group 會被正規化為 `config: []`。
- 明確的 `null` 無效。
- 自訂儲存必須在儲存目標之前驗證目標。

## 快照

Loader 擁有它自己的設定快照。

- 編輯 effect 執行時，它的資料會在被放入佇列之前複製。呼叫端之後的修改不會改變這個已排隊的編輯。
- 初始資料會被擷取，儲存的 `apply` 或 `refresh` 回傳的目標也會被擷取。
- 陣列和一般 record（包括中繼資料）會被複製並遞迴凍結。共用參照和環會被保留。
- `entries` 和 `changes` 公開這些已凍結的快照。不要修改它們。
- 呼叫端的原始物件保持未凍結。如果再次提交它們，Loader 會擷取它們的新值。
- Loader 已經擁有的快照可以直接共用，不需要再做一次深層複製。

類別實例（包括 `Env`
和其他 Data 類別）以及其他不透明的值會保留它們的參照，不會被凍結或複製。把它們作為設定提供時，請把它們當作不可變的。不透明值內部的修改不在快照的保證範圍內。

一般 record 上自有的存取器屬性，會在建立快照時按值擷取。

## Group ID

公開的 `Group.Group`
入口會在初次載入之前以及每次更新時檢查同層 ID，包括被停用的項目。

- 重複的同層項目會以 `SchemaError` 使 schema 解碼失敗，而不會合併成一個子項目。
- 這個檢查僅限於每個 group 內部。一個有問題的巢狀 group 可能失敗，而健康的同層項目照常執行。
- Loader 和 Include 還要求 ID 在整棵樹中唯一。

## 環境變數

Group 保留子項目的描述，但不解析它們的環境變數。只有啟用中的一般項目才會解析自己的
`!env`
值。所以缺少的變數只會使該項目失敗，而不會阻止它的同層項目載入。被停用的項目不解析變數。

設定陣列和一般 record 可以共用值，但不得包含環。

- 帶環的 config 或 intercept 會使其項目以 `Entry.CyclicConfig`
  失敗。它不會阻塞同層項目或之後的對帳。
- 其他類別實例在環境解析期間是不透明的值。
- 項目和 group 拓撲中的環會以 `InvalidOperation`
  被拒絕。這發生在配置 ID 或走訪樹之前。
- 每次執行，環境解析都使用全新的識別快取。共用的容器只解析一次，並保持共用。之後的執行會重新讀取環境值。
- 快照複製和環檢查也會追蹤物件識別。
- 設定比較對每一對一般容器只走訪一次，不會對圖做結構化雜湊。共用拓撲不影響值的相等性。
- 不透明的值保留 Effect 的相等性，包括自訂的相等性實作。

## 檔案寫入

檔案寫入依以下步驟進行：

1. 在同一目錄中以獨占方式建立暫存檔，模式為 `0600`。
2. 保留目標的權限位元以及可用的 uid/gid。
3. 對檔案執行 fsync 並關閉。
4. 將它重新命名到位。

新檔案預設為 `0600`。

- 失敗或中斷會清理暫存檔。清理失敗會與原始 Cause 合併。
- 這會保留 POSIX 權限，不會保留擴充 ACL 或擴充屬性。
- 不會對所在目錄執行 fsync。所以這不能保證重新命名在斷電後依然持久。

在重新命名之前，寫入器會再次讀取目標檔案，並檢查其內容是否仍與編輯所用的版本一致。

- 如果檔案變了，寫入器會捨棄暫存檔，並在新內容上重新套用這次編輯。最多嘗試三次。
- 如果檔案還修改了 API 編輯所涉及的欄位，則以檔案為準，編輯會被捨棄並給出警告。
- 持續的競爭會回傳 `StoreError`。
- 清理失敗會保留其 cause，並停止重試。
- 初次建立和自動寫入 ID，使用同樣的版本檢查。

這是樂觀並行。編輯器仍可能在最後一次檢查與重新命名之間儲存，而這次儲存可能被覆蓋。如果無法接受遺失重疊的儲存，請避免同時進行 API 編輯和編輯器儲存。

## YAML 別名與 ID

YAML 編輯會保留別名原有的值。

- 在編輯修改或移除錨點之前，受影響的別名會變成獨立的副本。
- 透過帶別名的 group 編輯子項目，同樣會建立本機副本。來源集合保持不變。
- 未受影響的別名保持完整。
- 最終的文件在寫入之前會被解碼，並與目標核對。
- YAML 解析和序列化失敗會回傳 `StoreError`，並保留原始 cause。

項目和 group 結構邊界上的別名，會在收集、配置和驗證 ID 之前被實體化。所以帶別名的 group 中的匿名子項目會得到互不相同的 ID，而來源範本不會被修改。一般外掛設定內部無關的別名保持不變。

匿名識別由下而上比對。子項目先恢復自己的 ID，然後才比較其父項目的設定。所以重寫同一棵匿名樹，會保留它正在執行的實例。

- ID 的配置只有在比對完成之後才寫入 YAML。
- 計畫中包含一個獨立的邏輯目標。
- 在插入 ID 之前，指向已變化項目或其祖先的別名，會以原始值實體化。所以一般設定的別名永遠不會僅僅因為其來源項目需要 ID 而得到 ID。
- 序列化後的文件在提交之前會被解析，並與計畫的目標核對。不一致時回傳
  `StoreError`，檔案保持不變。
- 明確的 ID 是在設定變化時保持識別的辦法，也適用於原本相同的項目被含糊地重新排列的情況。

## Intercept

設定檔中的 intercept 需要明確註冊。在載入項目之前，請在建構 `Graft.layer`
所用的環境中提供一個 `Intercept.layer`：

```ts
import { Context, Layer, Schema } from "effect"

import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"

const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})

const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.String),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const environment = Layer.merge(references, ModuleResolver.fromRecord({}))
const runtime = Layer.provideMerge(Graft.layer, environment)
```

註冊表預設為空。Group 會解析該項目 intercept 中的 `Env`
值。然後每個註冊項做三件事：

1. 解碼 patch。
2. 讀取實際的 reference，包括它的預設值或繼承而來的值。
3. 呼叫它帶型別的合併函式。

不會自動合併物件。要取代純量值，請使用完整值的 schema 和
`(_, value) => value`。Schema 解碼時不得需要服務。

Intercept 的錯誤：

- 未知的 key 會使該項目以 `UnregisteredReference` 失敗。
- 無效的輸入會使它以 `InvalidIntercept` 失敗，schema 錯誤作為其 cause 保留。

請在應用程式啟動時註冊 reference。不要從由該 loader 管理的外掛中發布註冊表。

內建的 CLI 註冊了兩個 reference：

- `References.CurrentLogAnnotations` 合併註解欄位。
- `References.MinimumLogLevel` 在驗證之後取代層級。

其他 reference 需要在自訂的主機環境中註冊。

一般外掛設定和 intercept 值中的環境變數，會在該項目的啟用內部解析，包括巢狀的 intercept 陣列和 record。註冊的 schema 仍會在合併之前驗證解析後的值。

- 缺少的變數會使項目以 `ConfigError` 失敗。它儲存的目標保留原始的 `Env` 值。
- Group 解析它們自己的 intercept，每個後代自行準備。
- 被停用的項目不讀取任何變數。

## 監看設定檔

使用 `Include` 的 `watch`
選項時，無效的初始文件會連同其 cause 一起記錄日誌。空的 loader 和設定監看器仍然可用。儲存一個有效的文件，會在不重新啟動的情況下載入其中的項目。

API 編輯必須先讀取並驗證檔案，所以它們不會覆蓋無效的文件。

沒有 `watch` 時，無效的初始文件會使 `Include` 初始化失敗。

## 模組解析器

`ModuleResolver.make` 接受 Promise importer，或需要 `Scope` 的 Effect
importer。`resolve`
在項目生命週期的啟用 scope 中執行。移除項目會關閉該 scope，並卸載它的外掛子節點。

`resolve(name, { observationScope })`
可以指定獨立的觀察 scope；resolver 將它作為第二個參數傳給 importer。Group 按設定項目持有觀察 scope，並用
`ScopedRef`
在重試時取代代次。失敗候選的資源仍立即清理，HMR 對檔案的觀察則保留到重試、移除或停用。省略選項時，觀察歸呼叫端 scope 所有。

- 解析成功之後，一般的設定更新、待處理的注入和失敗的外掛啟用，都會保留 resolver 租約。
- 重新啟動生命週期會先釋放舊租約，再取得新的租約。這包括解析期間的設定變化，以及從準備失敗中復原。
- 對於 HMR，請傳入 `hmr.importerScoped`。這樣被移除的項目就不再參與重載。

## 符號連結

Include 會保留符號連結。每次磁碟操作先解析設定路徑的實際目標，並將該路徑與內容快照一起保存。讀取、衝突檢查、自動補 ID 和 API 編輯都使用同一目標，暫存檔也建立在目標目錄。rename 前會再次解析入口；若指向已變，就刪除暫存檔，沿用既有的有限重試與同欄位衝突規則，在新目標上重新套用編輯。

watch 模式同時監聽入口目錄和目前目標目錄。入口連結改變後會重新讀取，並關閉舊目標監聽、切換至新目標目錄；新監聽就緒後再請求一次讀取。新目標 YAML 無效時保留上一次有效的執行樹，修正該檔案後可恢復。未開啟 watch 時，下次 API 編輯會讀取新目標。位於這兩個監聽目錄之外的中間連結，其變化會在下次讀取時生效，但本身不一定觸發通知。

一般檔案不存在時可以初始化。失效、循環或無法存取的連結會傳回具型別的檔案系統錯誤，不會被替換成一般檔案；請先建立或修復目標，再重試。API 編輯或入口變更通知都會重新嘗試解析路徑。

路徑核對與 rename 是兩個獨立操作。連結若在最後核對之後改變，進行中的編輯仍可能提交至舊目標；下次讀取則跟隨新目標。這與內容核對後的並行儲存競爭區間相同，不構成跨檔案交易。

## 文件

- [設定檔](https://graftland.github.io/graft/zh-tw/config-file/)
- [在你的程式中使用 Graft](https://graftland.github.io/graft/zh-tw/embedding/)

屬於 [Graft](https://github.com/graftland/graft)。依
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權。

`ModuleResolver.make` 的選用 `resolution`
協定快取解析計畫，不快取 importer 結果。`revision`
在安裝、移除或解析環境變更後必須更新；`exists` 只檢查候選是否存在；`observe`
在每次解析（包括快取命中）中取得觀察租約。未提供此協定時，每次仍以原名稱優先執行 importer。詳見
[Resolution plans](./README.md#resolution-plans)。
