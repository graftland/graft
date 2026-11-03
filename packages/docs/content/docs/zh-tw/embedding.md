---
title: 在程式中使用 Graft
description: 從自己的 Effect 程式執行外掛，不需要 CLI。
---

CLI 是建立在這些函式庫之上的一個小程式。你也可以用同樣的方式，在自己的 Effect 程式中執行 Graft。

## 直接執行外掛

`Graft.layer` 建立執行階段。在 `Scope` 內載入外掛，關閉 `Scope` 就會卸載它們：

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import { Effect, Layer } from "effect"

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

program.pipe(
	Effect.scoped,
	Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	NodeRuntime.runMain,
)
```

Layer 環境中的服務對所有外掛都可用，這裡就是 Node.js 服務。請參閱[來自環境的服務](../services/#來自環境的服務)。

## 載入設定項目

`Loader.plugin`
執行保存在記憶體中的[設定項目](../config-file/#設定項目欄位)清單。透過 `Loader`
服務所做的編輯只會修改這份清單。設定項目需要 `ModuleResolver` 將名稱解析為外掛：

```ts
import { Loader, ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Loader.plugin, [
		{ id: "greeter", name: "greeter", config: { greeting: "Hello" } },
		{ id: "hello", name: "hello" },
	])
	return yield* Effect.never
})

const resolver = ModuleResolver.fromRecord({ greeter, hello })
```

`ModuleResolver.fromRecord`
從固定的對照表解析名稱，適合打包後的應用程式和測試。`ModuleResolver.layer({ base, importer })`
則透過匯入模組來解析：相對名稱從 `base` 解析，套件名稱透過 `importer`
解析。`importer` 通常是在應用程式中撰寫的
`(specifier) => import(specifier)`，如此才能找到應用程式的相依套件。

將解析器和 Node.js 服務一起提供到環境中：

```ts
program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(NodeServices.layer, resolver),
		),
	),
	NodeRuntime.runMain,
)
```

### 解析計畫

`ModuleResolver.make` 快取正規化的候選計畫，不快取 importer 的結果。未提供選用的
`resolution`
環境時，每次呼叫仍先嘗試原始名稱，再依命名慣例嘗試。成功的 importer 每次都會執行，因此自訂 importer 的逐次呼叫行為和資源 scope 保持不變。

`resolution` 環境可以略過已知不存在的候選：

- `revision`
  是傳回解析環境版本的 Effect。安裝、移除相依套件或其他解析變更後，應更新版本，使舊計畫失效，包括「不存在」的判斷。
- `exists(specifier)`
  檢查正規化候選是否存在，不匯入模組，也不取得資源；候選優先順序保持不變。
- `observe(specifiers, { observationScope })`
  在每次解析時執行，包括快取命中和計畫失敗，用來保留缺少名稱或路徑的觀察。資源仍歸候選 scope 和觀察 scope 所有。

啟用這個協定時，必須同時提供失效機制和觀察機制。無法可靠維護版本時，請勿設定
`resolution`。尚未完成的舊計畫不會覆寫較新版本的快取。

## 載入設定檔

`Include.Include` 是 `graft start`
使用的外掛。它讀取 YAML 檔案並將編輯結果寫回；設定 `watch: true`
後，還會接收你手動做的修改：

```ts
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

它需要 `FileSystem` 和 `Path`，例如由 `NodeServices.layer` 提供。使用 `initial`
時，如果檔案尚未存在，會用這些初始設定項目建立檔案。
