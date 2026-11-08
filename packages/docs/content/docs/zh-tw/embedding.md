---
title: 在自己的程式中使用 Graft
description: 在自己的 Effect 程式中執行外掛，無需 CLI。
---

**嵌入式 Graft**
在你的 Effect 程式內組合外掛。生命週期是協作式的，不提供核心 Change 結果、隔離或依靠終止完成的資源回收。

| 你想要…                 | 使用                                | 章節                               |
| ----------------------- | ----------------------------------- | ---------------------------------- |
| 從程式碼載入少量外掛    | `Graft.layer` 和 `Graft.plugin`     | [直接執行外掛](#直接執行外掛)      |
| 從一份項目清單載入外掛  | `Loader.plugin` 和 `ModuleResolver` | [載入設定項目](#載入設定項目)      |
| 從 YAML 檔案載入外掛    | `Include.Include`                   | [載入設定檔](#載入設定檔)          |
| 不使用 CLI 而重載程式碼 | `@graftland/hmr`                    | [HMR API](../hmr-api/)             |
| 測試外掛                | `@effect/vitest` 和 `Graft.layer`   | [測試](../best-practices/testing/) |

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

export const run = () =>
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

嵌入式 `Loader.plugin`
依設定項目清單載入建置後的模組。解析需要有效的公開控制端點來執行可丟棄檢查；相對 include 保留宣告它的目錄。

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address
const resolver = ModuleResolver.layer({ base: "/app", control }).pipe(
	Layer.provide(NodeServices.layer),
)
export const run = () =>
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(Loader.plugin, [
			{ id: "hello", name: "./dist/hello.js" },
		])
		yield* fork.stable
	}).pipe(
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

| 邊界       | 規則                                                       |
| ---------- | ---------------------------------------------------------- |
| 解析       | 回傳可序列化描述符，在可丟棄單元中檢查可執行程式。         |
| 嵌入式啟用 | 在嵌入它的行程中執行，以協作方式管理 scope。               |
| 設定       | 原生準備只傳遞 JSON 和不可變模組身分。                     |
| 保證       | 嵌入式 fork 不提供 Change 結局、強制回收或程式碼卸載保證。 |

測試使用真實模組檔案。原始碼變更後先建置，再重新啟動嵌入行程。原生準備和嵌入式編輯服務請見
[Loader API](../loader-api/)。

## 載入設定檔

嵌入式程式可透過 `Include.Include` 讀取和編輯 YAML，`watch: true`
協作式監看檔案修改。`graft start` 只讀取一個版本，不支援 `--watch`。

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
