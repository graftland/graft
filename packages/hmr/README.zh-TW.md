# @graftland/hmr

[English](https://github.com/graftland/graft/blob/main/packages/hmr/README.md) |
[简体中文](https://github.com/graftland/graft/blob/main/packages/hmr/README.zh-CN.md)
| 繁體中文

在 Node.js 上熱重載外掛模組，不需要重新啟動行程。

```sh
npm install @graftland/hmr effect
```

`Hmr.make` 為載入器提供一個 importer，同時提供 `reload` 和
`watch`，用新程式碼取代外掛。需要 Node.js 22.19 或更新版本。

## 監看檔案

`watch`
使用原生檔案系統事件，所以重載很快。它還會每秒檢查一次監看路徑內已載入的、帶版本的模組的內容，以捕捉原生後端漏掉的變更。例如：

- macOS 目錄監看器的啟動空窗期
- import 與監看器安裝之間發生的儲存

檢查的運作方式：

- 新載入的模組會與它的模組鉤子讀取的位元組進行比較。所以透過設定新增外掛，不會被算作檔案變更。
- 每次磁碟觀察都與一次 import 嘗試，以及該嘗試實際讀取的位元組相關聯。
- 較新的已提交或已失敗的嘗試會使較舊的觀察失效。所以在快照與 import 之間發生的儲存，不會讓正在執行的外掛停留在錯誤的版本上。
- 未發生變化的失敗嘗試會保持已確認狀態，直到下一次變更。輪詢不會反覆重試它。
- 檢查遵循 `recursive`，並在消費者關閉串流時停止。
- 它的開銷取決於這些模組的內容，而不是目錄樹的大小。

`watch(paths, options)` 除了 `recursive`、`onReady` 和 `debounce` 之外，還接受
`filter(absolutePath)`。這個謂詞同時過濾原生事件和定期的內容檢查。預設接受所有路徑。例如：

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

CLI 對 `node_modules`
之外的 JavaScript 和 TypeScript 模組檔案使用這個過濾器。YAML 設定的變更屬於載入器處理，永遠不會觸發對所有項目的 HMR 重載。

## 失敗

防抖動不會讓檔案寫入變成原子操作。如果重載遇到不完整的程式碼，它會發出
`Failed`，並帶上原始的
`Cause`。之後的內容變更可以觸發復原，即使沒有新的原生事件。

監看器 I/O 失敗和對帳 I/O 失敗都會使串流失敗。所以消費者應該處理這兩個失敗通道。

`onReady` 表示監看器已安裝。它不是作業系統層級的事件投遞屏障。

## 何時需要重新啟動

CommonJS 和原生相依套件需要重新啟動行程。HMR 依工作階段的 generation 追蹤相依資訊，其中包括入口 import 完成之後、外掛啟用期間的動態 import。一旦 HMR 記錄了這樣的相依套件，該 generation 之後的重載都會回傳
`Skipped`，原因是 `restart-required`。

透過 `require` 載入的模組不受 ESM URL 版本的隔離，包括
`require(esm)`。HMR 在這裡很謹慎：帶版本的模組只要 import 了 `node:module`（或
`module`），HMR 就認為它取得了一種無法追蹤的原生載入能力。該相依圖會回傳
`Skipped / restart-required`，即使這個模組只用了 `node:module`
裡的其他工具。HMR 在使用之前就記錄這種能力，這樣可以涵蓋 CommonJS 快取命中的情況，並且在另一個入口取得同樣的能力時仍然有效。需要熱重載的相依套件請使用靜態或動態的 ESM
import。

即使沒有檔案通知，監聽也會回報已知的原生載入重新啟動要求，包括啟動後才取得該能力的外掛。週期性狀態檢查不會重複回報相同狀態；這條警告不表示已經執行重載。

本機檔案入口及其可達相依邊會按代次保留請求路徑、匯入方和實體目標。入口和相依檔案共用檢查邏輯及輪詢資料；失敗待重試的相依圖繼續保留，最後一個租約釋放後不再參與檢查。重載在 import 之前檢查這個關係，在發布任何取代之前再檢查一次。如果符號連結的目標變了，重載會回傳
`Skipped / restart-required`，並附上受影響的請求 URL，所有正在執行的外掛保持不變。輪詢也會檢查這個關係，包括內容相同的目標和漏掉的原生事件。重新指定入口或 helper 的目標之後，請重新啟動行程。HMR 不會使 Node 的解析快取失效。這些檢查涵蓋追蹤相依圖中的本機檔案請求，不涵蓋套件的 export
map 或裸套件解析的變化。

## 入口租約

`importerScoped(specifier)` 是一個需要 `Scope`
的 Effect。每次呼叫都持有該入口的一個租約。最後一個租約釋放後，該入口不再參與之後的重載。

首次匯入失敗後，觀察租約仍由設定項目持有，與立即關閉的候選資源 scope 分離。修正模組後，即使原生通知遺失，也能透過輪詢復原。重試會取代觀察代次，移除或停用設定項目則關閉觀察 scope。

`importerScoped(specifier, { observationScope })`
將觀察租約與候選匯入的暫時資源分開。`ModuleResolver`
透過 importer 的第二個參數傳遞這個 scope。失敗項目等待重試時應保留它，取代觀察嘗試或移除項目時關閉它；候選資源仍在失敗時立即清理。省略此選項時使用呼叫端的 scope。

原生 watcher 在來源資源清理完成後、進入背景合併邊界之前觀察完整 Exit。包含失敗的中斷會在這裡記錄完整 Cause，純中斷不記錄錯誤；一般後端失敗繼續交給消費端處理，不重複記錄。

CLI 把這個 importer 傳給
`ModuleResolver`。它的入口 scope 在設定更新、啟用失敗或啟用等待期間保持存活，並在入口被移除時關閉。

輪詢和重新啟動如何與租約配合：

- 輪詢根據每個存活的租約決定檔案集合，使用正在執行的 generation 和最近一次未提交的 import 嘗試。
- 它會保留失敗的 import 和缺少的本機相依套件，以便重試。
- 當最後一個擁有者關閉時，它不再讀取該入口以及僅被該入口使用的相依套件。
- 成功的取代會讓舊的相依圖退役。
- 只有從被租用的入口可以到達的相依套件，才可能要求重新啟動。
- 以 Promise 為基礎的 `importer` 會保留它的註冊，直到 HMR 工作階段關閉。

## 取代衝突

有時多個入口原本共用同一個 Plugin 物件，現在卻匯出了不同的物件。此時重載回傳
`Skipped`，原因是 `ambiguous-exports`，並附上受影響的模組 URL。

另外兩種情況會回傳 `Skipped`，原因是 `identity-conflict`，並附上衝突的模組 URL：

- 取代的識別有重疊，例如 `P → Q, Q → R`。
- 對應與現有的執行期別名不一致。

在所有這些情況下，都不會取代任何東西。請重新啟動應用程式，或還原成一個可以表示的對應。驗證與別名發布共用核心的取代交易。

## 取消

模組在取消期間失敗時，HMR 會連同完整的 Cause 一起記錄原始失敗。它在待處理的中斷掩蓋已完成的 Exit 之前完成這一步。

## 文件

- [熱重載](https://graftland.github.io/graft/zh-tw/hot-reload/)

屬於 [Graft](https://github.com/graftland/graft)。依
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權。
