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
	name: "app/tenant",
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
	name: "app/greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "app/hello",
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

原生準備流程傳遞有序的 JSON 修補和不可變的環境模組描述符。解碼與合併程式在檢查單元和執行單元中執行。環境模組匯出 Layer，`Configuration.Options`
提供編碼後的選項。

```ts title="settings.ts"
import { Context, Effect, Layer, Schema } from "effect"

import { Configuration } from "@graftland/plugin-remote"

export const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})
const Patch = Schema.Struct({
	color: Schema.optionalKey(Schema.Trim),
	size: Schema.optionalKey(Schema.Finite),
})
export default Layer.effect(
	Settings,
	Effect.gen(function* () {
		const input = yield* Configuration.Options
		const patch = yield* Schema.decodeUnknownEffect(Patch)(input)
		const outer = yield* Settings
		return { ...outer, ...patch }
	}),
)
```

依 Reference 的鍵登記模組描述符，再準備外掛；準備不會啟用外掛。

```ts
import { Effect, HashMap } from "effect"

import { ModuleResolver, Preparation } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

export const prepared = Effect.gen(function* () {
	const resolver = yield* ModuleResolver.make({ base: "/app", control })
	const module = yield* resolver.resolve("@acme/graft-plugin-api")
	const settings = yield* resolver.resolve("./dist/settings.js", {
		kind: "Environment",
	})
	const prepare = yield* Preparation.make({
		control,
		intercepts: HashMap.make(["app/Settings", settings]),
	})
	return yield* prepare.inspect({
		instance: "api",
		module,
		input: { port: 8080 },
		intercept: [{ key: "app/Settings", patch: { color: "red" } }],
	})
})
```

| 輸入           | 規則                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| 繼承           | 先套用父層修補，再套用子層修補；每份設定都建構新的 Layer。             |
| 未登記的鍵     | 在啟動單元前回傳 `PreparationFailed`，原因為 `UnregisteredIntercept`。 |
| 無效修補       | 檢查保留完整 cause 並失敗，不呼叫外掛的 apply。                        |
| 函式和活動物件 | 因不是 JSON 資料而遭拒。                                               |
| 復原           | 重新建構環境，並依目前策略重新解析參照。                               |

明確嵌入的應用程式可用 `Intercept.make` 和 `Intercept.layer`
登記單元內的解碼與合併邏輯。這些函式和環境服務不會跨越原生邊界。準備流程請見
[Loader API](../loader-api/)，協作式組合請見[嵌入](../embedding/)。
