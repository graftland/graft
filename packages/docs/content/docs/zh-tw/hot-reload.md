---
title: 熱重載
description:
  Graft 如何在執行中的 Node.js 行程內替換外掛程式碼，以及這種方式的限制。
---

使用 `graft start --watch`
時，儲存外掛模組就會用新程式碼取代正在執行的外掛。行程繼續執行，不是從外掛模組載入的部分也繼續執行，例如環境中的服務。

## 儲存後會發生什麼

1. Graft 重新匯入所有已登記的外掛模組，形成新的一**世代（generation）**。每個模組 URL 都會加上世代編號。Node 的模組掛鉤（module
   hooks）也會替外掛匯入的每個模組，加上這一世代的新版本。因此，修改輔助檔案也會更新使用它的外掛。
2. 如果所有模組都成功匯入，並且仍然匯出外掛，Graft 會呼叫
   [`Graft.replace`](../lifecycle/#取代外掛)，在一個交易中取代所有新外掛。每個模組都產生了新的外掛，所以從模組載入的每個 fork 都會依正常的[服務撤回順序](../services/#服務撤回流程)停止，再用新程式碼啟動。
3. 只要有任何模組匯入失敗，Graft 就不會取代任何東西。舊程式碼繼續執行，錯誤及其 cause 會記錄到日誌中。有一個例外：檔案已被刪除的外掛模組。Graft 會把它從這次重載中移除，其他外掛照常取代。它的 fork 會繼續執行舊程式碼，直到被卸載。

重載之後，Graft 會再次嘗試載入先前因外掛無法載入而失敗的項目。因此修好壞掉的外掛後，不必重新啟動就能讓它啟動。

相鄰的檔案事件會經過 50 毫秒的防抖動。CLI 會遞迴監看設定目錄下的
`.js`、`.mjs`、`.cjs`、`.ts`、`.mts` 和 `.cts` 檔案，但排除
`node_modules`。YAML 編輯由載入器處理，不會重載所有外掛模組。

原生 watcher 可能漏掉通知，例如在 macOS 的啟動期間。所以 HMR 也會每秒檢查一次監看範圍內已載入模組的內容。基準來自實際匯入的位元組，因此可以偵測到在 watcher 安裝之前所做的儲存。透過設定新增外掛，本身不會觸發重載。檢查會比較內容，所以大小相同的修改也能偵測到，並且會隨 watcher 一起停止。每次觀察都屬於某一次匯入嘗試及其實際的來源位元組。新的嘗試完成後，輪詢會重新對照這些位元組檢查，包括檔案在重載期間又回到先前快照的情況。如果失敗的嘗試已讀取來源位元組，它也會推進這個基準。沒有變化的失敗不會造成輪詢重試迴圈。檢查的成本會隨已載入模組的內容總量增加。

不完整的寫入可能導致重載失敗。Graft 會記錄完整的 cause 並繼續監看。之後的內容變更即使沒有原生事件，也能讓它恢復。CLI 也會記錄 watcher 的 I/O 失敗，並在一秒後重新安裝 watcher。

CLI 會在設定項目存活期間，替每個模組登記。移除或停用項目時，會釋放它的租約（lease）。最後一個租約關閉後，重載就不再匯入該項目。等待中和啟用失敗的項目會保留租約，讓之後的變更仍能讓它們恢復。已卸載的項目及其獨占的 CommonJS 相依套件，不會阻擋其餘的項目。輪詢也會跟隨租約。它涵蓋每個存活項目執行中的相依圖，以及最近一次尚未提交的匯入嘗試，包括失敗的匯入，以及重試所需、但尚不存在的本地檔案。最後一個擁有者釋放後，這些路徑就會退出輪詢。成功取代之後，舊的相依圖會被淘汰。仍有擁有者的路徑發生真正的 I/O 錯誤時，監看串流仍會失敗。

假設兩個項目原本匯出同一個 Plugin 物件，現在卻匯出不同的物件。這時重載會傳回
`Skipped`，`reason` 為
`ambiguous-exports`，並列出發生衝突的模組 URL。CLI 會回報需要重新啟動，所有舊外掛維持原狀。恢復共用的匯出，重載也能恢復。新舊取代身分還必須與執行階段的 alias 相容。例如
`P → Q, Q → R` 無法表示兩次獨立的取代。此時重載會傳回 `Skipped`，`reason` 為
`identity-conflict`，並列出發生衝突的模組 URL。驗證會在發布 alias 或變更任何 fork 之前，拒絕整批取代。

在取消期間才完成的失敗，會在恢復可中斷狀態之前，以完整的 Exit 交接。HMR 會記錄本來可能被取消掩蓋的原始失敗，包括完整的 Cause。

如果帶版本的模組匯入 `node:module` 或 `module`，HMR 會保守地要求重新啟動。這會在
`createRequire` 呼叫命中快取之前，先記錄原生載入能力。它涵蓋 `require(esm)`
以及 CommonJS。即使只使用該模組中不相關的工具函式，這張相依圖也會退出熱重載。需要重載的相依套件，請使用 ESM 匯入。

本地檔案項目會同時保留請求的路徑和實體目標。如果項目的符號連結（symlink）改指向新的目標，重載會在取代任何外掛之前，傳回
`Skipped / restart-required`，並列出受影響的請求 URL。即使檔案的位元組相同、原生通知也已遺失，輪詢仍能偵測到目標變更。請重新啟動以使用新的目標。HMR 不會清除 Node 的解析快取。這項檢查不會重新解析裸套件名稱或套件的 export
map。

## 外掛模組的規則

- **匯入模組不得產生副作用。** Graft 每次重載都會重新匯入模組，而只有 `apply`
  是在 Graft 能關閉的 scope 內執行。請在 `apply`
  中開啟連線、啟動伺服器和設定計時器。
- 只有 ECMAScript 模組可以重載。CommonJS 模組或原生附加元件變更時，Graft 會在日誌中提示需要重新啟動。Graft 會依世代追蹤相依套件，直到工作階段結束。這包括
  `apply` 之後才發生的動態匯入。這些相依套件也會讓之後的重載傳回 `Skipped`。
- `node_modules`
  中的套件是共用的，不會重載。Effect 和 Graft 本身必須始終只有一份。有一個例外：外掛所在的那個模組。來自某個套件的外掛會被重新匯入，但該套件的其他檔案不會。
- 支援的最低 Node.js 版本是 22.19。這與 CLI 的 Effect
  Node 轉接器的要求一致，也提供了 `module.registerHooks`。

## 限制

Node 會把匯入過的每個模組版本都保留在記憶體中，而且無法移除其中任何一個。所以每次重載都會用掉一部分永遠不會釋放的記憶體。開發期間通常沒問題。長時間執行的開發行程請不時重新啟動，並且不要在正式環境使用
`--watch`。

如果匯入永遠無法完成，會拖住之後的重載和關閉流程。例如模組頂層的 `await`
一直不會 resolve。這是因為動態匯入無法取消。

## 在自己的程式中使用

`@graftland/hmr` 套件可以不依賴 CLI 獨立使用：

```ts
import * as Hmr from "@graftland/hmr"
import { ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: hmr.importerScoped,
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	// ...load plugins through the resolver, then, after files changed:
	const result = yield* hmr.reload
	yield* Effect.log(result)
})
```

`make` 需要 `Graft.Graft` 和一個
`Scope`。關閉 scope 時，它會等待執行中的匯入完成，並移除模組掛鉤。匯入這個套件本身不會啟動任何東西。

| 成員                      | 作用                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include })` | `base` 是解析名稱所依據的模組 URL，通常是 `import.meta.url`。`include(url)` 決定哪些檔案會取得新版本：預設是 `node_modules` 之外的所有檔案。         |
| `importer(specifier)`     | 匯入外掛模組，登記會持續到 HMR 工作階段關閉。                                                                                                        |
| `reload`                  | 傳回包含已重載模組的 `Reloaded`，或在需要重新啟動時傳回 `Skipped`。模組無法匯入，或沒有匯出外掛時，以 `HmrError` 失敗，其 `cause` 是原始錯誤。       |
| `watch(paths, options)`   | 一個串流：`paths` 下的檔案變更後，先等待 `debounce`（預設 50 毫秒）以收集更多變更，然後重載。失敗的重載會以帶有 cause 的 `Failed` 發出，監看會繼續。 |

`importerScoped(specifier)` 傳回一個需要 `Scope`
的 Effect；每次呼叫都會持有一個項目租約，直到該 scope 關閉。請把它傳給
`ModuleResolver.make`，它同時接受 Effect importer 和 Promise
importer。以 Promise 為基礎的 `importer(specifier)`
則會在整個 HMR 工作階段內保留它的登記。

首次匯入失敗後，觀察租約仍由設定項目持有，與立即關閉的候選資源 scope 分離。修正模組後，即使原生通知遺失，也能透過輪詢復原。重試會取代觀察代次，移除或停用設定項目則關閉觀察 scope。

`importerScoped(specifier, { observationScope })`
將觀察租約與候選匯入的暫時資源分開。`ModuleResolver`
透過 importer 的第二個參數傳遞這個 scope。失敗項目等待重試時應保留它，取代觀察嘗試或移除項目時關閉它；候選資源仍在失敗時立即清理。省略此選項時使用呼叫端的 scope。

原生 watcher 在來源資源清理完成後、進入背景合併邊界之前觀察完整 Exit。包含失敗的中斷會在這裡記錄完整 Cause，純中斷不記錄錯誤；一般後端失敗繼續交給消費端處理，不重複記錄。

`WatchOptions.filter(absolutePath)`
決定哪些檔案可以觸發重載。原生事件和定期的內容檢查使用同一個述詞；省略時會接受所有路徑。`recursive`
控制是否包含子目錄。例如：

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

重載失敗是包含完整 `Cause` 的 `Failed`
值。watcher 和內容檢查的 I/O 失敗會讓串流本身失敗，所以呼叫端也必須處理這個通道。`onReady`
表示 watcher 已安裝，並不保證作業系統會送達每一個事件。
