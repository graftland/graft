---
title: HMR API
description: 在自己的程式中使用 @graftland/hmr，無需 CLI。
---

`@graftland/hmr`
套件無需 CLI 也能運作。熱重載做了什麼，請參閱[熱重載](../hot-reload/)。

```ts
import { Effect } from "effect"

import * as Hmr from "@graftland/hmr"

export const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	yield* hmr.importerScoped("./dist/plugin.js")
	return yield* hmr.reload
})
```

`make` 需要 `Graft.Graft` 和一個
`Scope`。關閉該 scope 時，它會等待執行中的匯入結束，並移除模組鉤子。匯入這個套件本身不會啟動任何東西。

## 成員

| 成員                                         | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include, activationTimeout })` | `base` 是解析名稱時的模組 URL，通常是 `import.meta.url`。`include(url)` 選出要取得新版本的檔案，預設選出 `node_modules` 之外的所有檔案。`activationTimeout` 是重載後的外掛啟動的時限，逾時則回滾重載；預設 30 秒。                                                                                                                                                                                                                                    |
| `importer(specifier)`                        | 匯入外掛模組，並保持註冊直到 HMR 工作階段關閉。                                                                                                                                                                                                                                                                                                                                                                                                       |
| `importerScoped(specifier, options?)`        | 回傳需要 `Scope` 的 Effect。每次呼叫都持有一個項目租約，直到該 scope 關閉。請參閱[具 scope 的匯入器](#具-scope-的匯入器)。                                                                                                                                                                                                                                                                                                                            |
| `reload`                                     | 強制完整重載所有已註冊的項目和被追蹤的相依項目。傳回帶有已重載項目的 `Reloaded`；回滾恢復成功時傳回帶有項目及其[失敗](../replace/#回滾)的 `RolledBack`（恢復為 `Pending` 也算成功）；舊程式碼重新啟動失敗時傳回 `RecoveryFailed`，帶有項目、取代的 `failures` 和恢復失敗的 `recovery`，保留完整 cause；變更[無法套用](../hot-reload/#重載不適用的情況)時傳回 `Skipped`。如果模組無法匯入或沒有匯出外掛，會以 `HmrError` 失敗，其 `cause` 是原始錯誤。 |
| `watch(paths, options)`                      | 當 `paths` 下被觀察的內容或本機解析結果變更時，增量重載受影響項目的串流。它會先等待 `debounce`（預設 50 ms）以收集更多變更。發出與 `reload` 相同的結果，包括 `RecoveryFailed`；匯入或檢查失敗會以帶有完整 cause 的 `Failed` 發出，監看繼續進行。                                                                                                                                                                                                      |

## 具 scope 的匯入器

| 匯入器                      | 租約持續到…             | 接受                             |
| --------------------------- | ----------------------- | -------------------------------- |
| `importer(specifier)`       | 整個 HMR 工作階段關閉。 | Promise 匯入器。                 |
| `importerScoped(specifier)` | 呼叫端的 scope 關閉。   | Effect 匯入器和 Promise 匯入器。 |

在明確的開發工具中直接使用具 scope 的匯入器。它不是可傳遞的 Loader 解析器。`graft start`
拒絕監看模式；HMR 的結果屬於嵌入式協作，不提供核心隔離或強制回收。

`importerScoped(specifier, { observationScope })`
將觀察租約保留到該 scope 關閉；省略時使用呼叫端的 scope。

## 監看

`WatchOptions` 控制串流看到什麼：

| 選項                   | 含義                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `filter(absolutePath)` | 選出哪些檔案可以觸發重載。它同時適用於原生事件和週期性的內容檢查。省略時，接受所有路徑。 |
| `recursive`            | 控制子目錄。                                                                             |
| `debounce`             | 等待更多變更的時間。預設 50 ms。                                                         |
| `onReady`              | 回報監看器已安裝。它不保證作業系統會送出每一個事件。                                     |

```ts
import { String } from "effect"

import type * as Hmr from "@graftland/hmr"

declare const hmr: Hmr.Hmr
declare const directory: string

const results = hmr.watch([directory], {
	recursive: true,
	filter: String.endsWith(".mjs"),
})
```

### 處理失敗

| 失敗                        | 出現的位置                                 |
| --------------------------- | ------------------------------------------ |
| 重載失敗                    | 帶有完整 `Cause` 的 `Failed` 值。          |
| 監看器或內容檢查的 I/O 失敗 | 串流本身失敗，因此呼叫端也必須處理該通道。 |
