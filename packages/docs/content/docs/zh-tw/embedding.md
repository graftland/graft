---
title: 在自己的程式中使用 Graft
description: 在自己的 Effect 程式中執行外掛，無需 CLI。
---

CLI 是建立在這些函式庫之上的一個小程式。你可以用同樣的方式，在自己的 Effect 程式中執行 Graft。

| 你想要…                  | 使用                                | 章節                               |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| 從程式碼載入少量外掛     | `Graft.layer` 和 `Graft.plugin`     | [直接執行外掛](#直接執行外掛)      |
| 從一份項目清單載入外掛   | `Loader.plugin` 和 `ModuleResolver` | [載入設定項目](#載入設定項目)      |
| 從 YAML 檔案載入外掛     | `Include.Include`                   | [載入設定檔](#載入設定檔)          |
| 不使用 CLI 而重載程式碼  | `@graftland/hmr`                    | [HMR API](../hmr-api/)             |
| 讓外掛在另一個行程中執行 | `Remote.plugin`                     | [在別處執行外掛](#在別處執行外掛)  |
| 測試外掛                 | `@effect/vitest` 和 `Graft.layer`   | [測試](../best-practices/testing/) |

## 直接執行外掛

`Graft.layer` 建立 runtime。在一個 scope 中載入外掛，關閉該 scope 就會卸載它們：

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { greeter, hello } from "./plugins.ts"

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

Layer 環境中的服務對每個外掛都可用，這裡就是 Node.js 的服務。請參閱[來自環境的服務](../services/#來自環境的服務)。

`greeter` 和 `hello` 都是一般的外掛，本頁其他範例也會載入它們。`greeter` 發布
`Greeter` 服務，`hello` 注入它：

```ts title="plugins.ts"
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

export class Greeter extends Context.Service<
	Greeter,
	{ readonly greeting: string }
>()("app/Greeter") {}

export const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: (config) => Graft.provide(Greeter, config),
})

export const hello = Plugin.make({
	name: "app/hello",
	inject: [Greeter],
	apply: () =>
		Effect.flatMap(Greeter, ({ greeting }) =>
			Effect.log(`${greeting}, world!`),
		),
})
```

## 載入設定項目

`Loader.plugin`
執行保存在記憶體中的[設定項目](../config-file/#設定項目欄位)清單。透過 `Loader`
服務所做的編輯只會改變這份清單。這些項目需要 `ModuleResolver` 把名稱轉成外掛：

```ts import.meta.vitest name="embedding: load entries"
import { Effect, Layer, Option, Stream } from "effect"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import { greeter, hello } from "./plugins.ts"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Loader.plugin, [
		{ id: "greeter", name: "greeter", config: { greeting: "Hello" } },
		{ id: "hello", name: "hello" },
	])
	return yield* Graft.logs.pipe(
		Stream.map((log) => log.message),
		Stream.runHead,
	)
})

const resolver = ModuleResolver.fromRecord({ greeter, hello })

await Effect.runPromise(
	program.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
	),
) // => Option.some(["Hello, world!"])
```

`Group.Group`
也接受沒有 id 的項目。插入不同名稱的項目不會改變既有項目的衍生 id；插入或移動同名項目時，請明確指定 id。見[託管項目](../plugins/#託管項目)。

### 選擇解析器

| 解析器                                     | 如何找到外掛                                                     | 適用於                 |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------- |
| `ModuleResolver.fromRecord(table)`         | 從固定的表中查找。                                               | 打包後的應用程式、測試 |
| `ModuleResolver.layer({ base, importer })` | 匯入模組。相對名稱從 `base` 解析，套件名稱透過 `importer` 解析。 | 含有外掛檔案的應用程式 |

通常 `importer` 是寫在你應用程式中的
`(specifier) => import(specifier)`，這樣它才能找到你應用程式的相依套件。

在應用程式中，把解析器提供在環境中，與 Node.js 服務放在一起：

```ts
import { Effect, Layer, type Scope } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import type { ModuleResolver } from "@graftland/loader"

declare const program: Effect.Effect<never, never, Graft.Graft | Scope.Scope>
declare const resolver: Layer.Layer<ModuleResolver.ModuleResolver>

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

`ModuleResolver.make` 快取的是正規化後的候選計畫，從不快取匯入器的結果。

- 沒有選用的 `resolution` 環境時，每次呼叫仍會先嘗試原始名稱，再嘗試命名慣例。
- 成功的匯入器在每次呼叫時都會執行，因此自訂匯入器保有每次呼叫的行為和資源 scope。

`resolution` 環境可以略過已知不存在的候選項目：

| 成員                                        | 作用                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `revision`                                  | 回傳解析環境版本的 Effect。在安裝、移除或其他解析變更之後推進它，以捨棄已快取的計畫，包括否定的決定。            |
| `exists(specifier)`                         | 檢查正規化後的候選項目，但不匯入也不取得資源。候選項目的優先順序保持不變。                                       |
| `observe(specifiers, { observationScope })` | 每次解析都會執行，包括快取命中和失敗的計畫，以保留對不存在的名稱或路徑的觀察。其資源遵循候選項目和觀察的 scope。 |

:::caution選擇啟用時，請同時提供失效機制和觀察。如果沒有可靠的
`revision`，請不要設定 `resolution`。較舊的進行中計畫不能覆寫較新的已快取版本。

:::

## 載入設定檔

`Include.Include` 是 `graft start`
背後的外掛。它讀取 YAML 檔案，並把編輯寫回該檔案。使用 `watch: true`
時，它也會接收你手動所做的變更：

```ts
import { Effect } from "effect"

import { Graft } from "@graftland/graft"
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

| 需求／選項 | 說明                                                         |
| ---------- | ------------------------------------------------------------ |
| 服務       | 需要 `FileSystem` 和 `Path`，例如來自 `NodeServices.layer`。 |
| `initial`  | 如果檔案尚不存在，就用這些項目建立檔案。                     |
| `watch`    | 接收手動所做的變更。                                         |

從程式碼編輯設定項目，請參閱 [Loader API](../loader-api/)。

## 在別處執行外掛

`@graftland/plugin-remote` 的 `Remote.plugin`
會建立一個外掛，讓契約的實作在子行程、worker 或 runner 上執行。像其他外掛一樣用
`Graft.plugin` 載入它：

```ts
import { Effect, Layer, type Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { hello } from "./plugins.ts"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ readonly greeting: Schema.String }>
>

const greeter = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	implementation: new URL("./greeter.js", import.meta.url).href,
	connect: { local: {} },
})

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto),
		),
	),
	NodeRuntime.runMain,
)
```

Remote 需要環境中有 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`。`hello` 仍然像以前一樣注入
`Greeter`。契約和其他選項請見[從 TypeScript 載入](../remote/hosts/#從-typescript-載入)。
