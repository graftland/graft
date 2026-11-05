---
title: Intercept
description: 為一個 fork 及其所有後代修改某項設定。
---

intercept 為一個 fork 及其所有後代修改 `Context.Reference`
的值。Reference 是一律有值的鍵。Effect 自身的設定就是 Reference，例如每行日誌附帶的註解。

| 你想要…                         | 使用                                            |
| ------------------------------- | ----------------------------------------------- |
| 在程式碼中修改 Reference        | `intercept` 選項中的 `Graft.intercept`。        |
| 在 `graft.yml` 中修改 Reference | 已註冊的[設定檔 intercept](#設定檔-intercept)。 |
| 讓 fork 擁有自己的服務或事件    | 改用[領域](../isolation/)。                     |

## 修改 Reference

```ts import.meta.vitest name="intercepts: change a reference"
import { Effect, References, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const tenant = Plugin.make({
	name: "tenant",
	config: Schema.Struct({ name: Schema.String }),
	apply: () => Effect.log("ready"),
})

const tenantA = Graft.plugin(
	tenant,
	{ name: "a" },
	{
		intercept: [
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: "a",
			})),
		],
	},
)

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* tenantA).await
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(
		Effect.annotateLogs({ app: "shop" }),
		Effect.scoped,
		Effect.provide(Graft.layer),
	),
)
line?.annotations["tenant"] // => "a"
line?.annotations["app"] // => "shop"
```

函式接收外層的值，因此 intercept 可以巢狀使用：該 fork 及其後代外掛輸出的每行日誌都會帶上
`tenant: "a"`，同時保留上層加入的註解。

## 隨呼叫端變化的設定

如果某項設定需要由服務從呼叫端讀取，可以使用 Reference。回傳 Effect 的服務方法在呼叫端的 fiber 中執行，因此能讀到呼叫端的 intercept：

```ts import.meta.vitest name="intercepts: settings that follow the caller"
import { Context, Effect, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

const greeter = Plugin.make({
	name: "greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("Ada")),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(greeter)
		yield* (yield* Graft.plugin(hello)).await
		const formal = Graft.intercept(Formal, () => true)
		yield* (yield* Graft.plugin(hello, undefined, { intercept: [formal] }))
			.await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Hi, Ada!"], ["Good day, Ada."]]
```

載入外掛時使用 `Graft.intercept(Formal, () => true)`，就能讓它從大家共用的同一個
`Greeter` 收到正式的問候。

## `inject` 中的 Reference

Reference 也可以列在 `inject` 中。

- 本 fork 領域中的 provision 優先於 intercept 的後備值。
- 子外掛先剝離父層的 provision，再套用自己的 intercept；它們會保留父層的後備值，包括被該 provision 遮蔽的 intercept。

## 設定檔 intercept

`Graft.intercept` 是有型別的程式碼 API；載入器的 YAML `intercept`
欄位則是不受信任的邊界，不接受任意字串鍵，必須明確註冊。

每個註冊項目包含三個部分：

| 部分      | 說明                                     |
| --------- | ---------------------------------------- |
| Reference | `Context.Reference` 物件。               |
| Schema    | 解碼設定的輸入。                         |
| 合併函式  | 有型別的函式 `(outer, patch) => value`。 |

請在執行載入器的環境中註冊，與外掛解析器和其他平台服務放在一起：

```ts import.meta.vitest name="intercepts: register a reference"
import { Context, Effect, Layer, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Intercept, Loader, ModuleResolver } from "@graftland/loader"

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

const show = Plugin.make({
	name: "show",
	apply: () => Effect.flatMap(Settings, Effect.log),
})

const environment = Layer.merge(references, ModuleResolver.fromRecord({ show }))
const runtime = Layer.provideMerge(Graft.layer, environment)

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(Loader.plugin, [
			{
				id: "show",
				name: "show",
				intercept: { "app/Settings": { color: "red" } },
			},
		])
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)
line?.message // => [{ color: "red", size: 12 }]
```

在 `graft.yml` 中，同一個設定項目寫成：

```yaml title="graft.yml"
- id: show
  name: show
  intercept:
    app/Settings:
      color: red
```

值的合併方式：

- 巢狀設定項目的補丁會接收父層的值，同層項目保留各自的值。
- Schema 在合併函式執行前解碼輸入，且不能依賴解碼服務。
- 合併函式的回傳型別必須符合 Reference。
- 純量取代或需要整體驗證的設定，可使用完整值 Schema，搭配
  `(_, value) => value`。

失敗情況：

| 問題       | 錯誤                                              |
| ---------- | ------------------------------------------------- |
| 鍵尚未註冊 | `UnregisteredReference`                           |
| 值無效     | `InvalidIntercept`，並在 cause 中保留 Schema 錯誤 |

這兩種情況下，該設定項目的外掛都不會啟動。

:::note

註冊表預設為空。請在建立載入器之前，透過宿主環境提供註冊表；載入器所管理的樹中的外掛，不能透過發布服務來註冊 Reference。預設的 CLI 註冊了
`References.CurrentLogAnnotations`（合併註解欄位）和
`References.MinimumLogLevel`（驗證後取代日誌層級）；其他 Reference 需要由自訂的宿主註冊。直接從程式碼使用的、有型別的
`Graft.intercept` API 不受此影響。

:::
