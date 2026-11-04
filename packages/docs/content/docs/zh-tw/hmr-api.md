---
title: HMR API
description: 在自己的程式中使用 @graftland/hmr，無需 CLI。
---

`@graftland/hmr`
套件無需 CLI 也能運作。熱重載做了什麼，請參閱[熱重載](../hot-reload/)。

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
`Scope`。關閉該 scope 時，它會等待執行中的匯入結束，並移除模組鉤子。匯入這個套件本身不會啟動任何東西。

## 成員

| 成員                                  | 作用                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make({ base, include })`             | `base` 是解析名稱時的模組 URL，通常是 `import.meta.url`。`include(url)` 選出要取得新版本的檔案，預設選出 `node_modules` 之外的所有檔案。                                                         |
| `importer(specifier)`                 | 匯入外掛模組，並保持註冊直到 HMR 工作階段關閉。                                                                                                                                                  |
| `importerScoped(specifier, options?)` | 回傳需要 `Scope` 的 Effect。每次呼叫都持有一個項目租約，直到該 scope 關閉。請參閱[具 scope 的匯入器](#具-scope-的匯入器)。                                                                       |
| `reload`                              | 強制完整重載所有已註冊的項目和被追蹤的相依項目。傳回帶有已重載模組的 `Reloaded`，或在需要重新啟動時傳回 `Skipped`。如果模組無法匯入或沒有匯出外掛，會以 `HmrError` 失敗，其 `cause` 是原始錯誤。 |
| `watch(paths, options)`               | 當 `paths` 下被觀察的內容或本機解析結果變更時，增量重載受影響項目的串流。它會先等待 `debounce`（預設 50 ms）以收集更多變更。失敗的重載會以帶有 cause 的 `Failed` 發出，監看繼續進行。            |

## 具 scope 的匯入器

| 匯入器                      | 租約持續到…             | 接受                             |
| --------------------------- | ----------------------- | -------------------------------- |
| `importer(specifier)`       | 整個 HMR 工作階段關閉。 | Promise 匯入器。                 |
| `importerScoped(specifier)` | 呼叫端的 scope 關閉。   | Effect 匯入器和 Promise 匯入器。 |

請將 `importerScoped` 傳給 `ModuleResolver.make`。

`importerScoped(specifier, { observationScope })`
會把觀察租約與暫時的匯入器資源分開。

- `ModuleResolver` 會把這個 scope 當作匯入器的第二個引數傳入。
- 在失敗的項目等待重試期間保持它存活，並在取代觀察嘗試或移除項目時關閉它。
- 候選項目的資源可以在失敗時立即關閉，而不會刪除該觀察。
- 省略此選項時，使用呼叫端的 scope。

在同一個匯入視圖中重新取得項目，會保留其已快取的身分。目前的視圖保留命中快取所需的事實，而不會監看沒有租約的項目。提交後的重載會淘汰該快取；觀察只會保留在仍被啟用中、等待中或被重用的圖所需要的地方。

## 監看

`WatchOptions` 控制串流看到什麼：

| 選項                   | 含義                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `filter(absolutePath)` | 選出哪些檔案可以觸發重載。它同時適用於原生事件和週期性的內容檢查。省略時，接受所有路徑。 |
| `recursive`            | 控制子目錄。                                                                             |
| `debounce`             | 等待更多變更的時間。預設 50 ms。                                                         |
| `onReady`              | 回報監看器已安裝。它不保證作業系統會送出每一個事件。                                     |

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

### 處理失敗

| 失敗                        | 出現的位置                                 |
| --------------------------- | ------------------------------------------ |
| 重載失敗                    | 帶有完整 `Cause` 的 `Failed` 值。          |
| 監看器或內容檢查的 I/O 失敗 | 串流本身失敗，因此呼叫端也必須處理該通道。 |
