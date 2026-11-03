---
title: 隔離與 intercept
description: 為外掛樹的某個分支提供獨立的服務、事件或設定。
---

## 領域

每個服務鍵和事件都歸屬於一個**領域（realm）**。預設情況下，整個應用程式只有一個領域：無論在哪裡發布服務，所有外掛都能看到；事件也會傳遞給所有處理函式。

`Graft.plugin` 的 `isolate`
選項可以針對指定的鍵，為一個 fork 及其所有後代建立獨立的領域：

```ts
const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})
```

每個 `tenant` fork 都可以發布自己的 `Database`，內部外掛只會看到這個
`Database`。外部發布的 `Database`
對內部不可見，反之亦然。未隔離的鍵仍然照常共用。

`isolate` 接受任何帶有 `key` 的物件，可以是 `Database`
這類服務鍵，也可以是[事件](../events/)。

### 共用領域

使用標籤可以讓多個 fork 加入同一個共用領域，而不是各自使用私有領域：

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

無論 `api` 和 `worker` 位於樹的哪個位置，它們都共用 `staging` 領域的
`Database`，看不到其他領域發布的 `Database`。

標籤與服務鍵或事件鍵是身分的兩個獨立部分。Graft 把它們各自當作完整的字串處理，包括內嵌的 NUL 字元。以
`#` 或 `@`
開頭的標籤不會指向私有領域；空標籤代表一個共用領域，這個領域與預設的根領域不同。

### 環境後備與繼承

領域隔離的是已發布的服務，不是建構 `Graft.layer`
時環境中的服務。如果領域中沒有某個注入鍵的 provision，消費者可以使用同鍵的環境值。在領域 A 發布或撤回服務，不會觸發領域 B 中使用環境後備的消費者重新啟動。

父外掛解析得到的 provision 不會透過 Effect
context 繼承傳給子外掛。子外掛必須透過自己的 `inject`
相依項目，在自己的領域中取得 provision。來自環境的值仍然可用。如果父外掛的 provision 遮蔽了根環境中的同鍵值，子外掛仍可以重新使用該環境後備。這個規則也適用於多代子外掛。

## intercept

intercept 為一個 fork 及其所有後代修改 `Context.Reference`
的值。Reference 是一律有值的鍵。Effect 自身的設定就是 Reference，例如每行日誌附帶的註解。

```ts
import { References } from "effect"

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
```

函式接收外層的值，因此 intercept 可以巢狀使用：該 fork 及其後代外掛輸出的每行日誌都會帶上
`tenant: "a"`，同時保留上層加入的註解。

如果某項設定需要由服務從呼叫端讀取，可以使用 Reference。回傳 Effect 的服務方法在呼叫端的 fiber 中執行，因此能讀到呼叫端的 intercept：

```ts
const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

// Inside the Greeter service:
const greet = (name: string) =>
	Effect.flatMap(Formal, (formal) =>
		Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
	)
```

載入外掛時使用 `Graft.intercept(Formal, () => true)`，就能讓它從大家共用的同一個
`Greeter` 收到正式的問候。

Reference 也可以列在 `inject`
中：本領域的 provision 優先於 intercept 的後備值。子外掛先剝離父層的 provision，再套用自己的 intercept；它們會保留父層的後備值，包括被該 provision 遮蔽的 intercept。

### 設定檔中的 intercept

`Graft.intercept` 是有型別的程式碼 API；載入器的 YAML `intercept`
欄位則是不受信任的邊界，不接受任意字串鍵，必須明確註冊。請在應用程式啟動時，註冊 Reference 物件、其輸入的 Schema 和有型別的合併函式：

```ts
import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"
import { Context, Layer, Schema } from "effect"

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

在此 runtime 中執行載入器，並將實際的外掛解析器和其他所需的平台服務加入
`environment`。之後設定項目可以這樣寫：

```yaml
intercept:
  app/Settings:
    color: red
```

結果為
`{ color: "red", size: 12 }`。巢狀設定項目的補丁會接收父層的值，同層項目保留各自的值。Schema 在合併函式執行前解碼輸入，且不能依賴解碼服務；合併函式的回傳型別必須符合 Reference。純量取代或需要整體驗證的設定，可使用完整值 Schema，搭配
`(_, value) => value`。

註冊表預設為空。未知的鍵會讓設定項目以 `UnregisteredReference` 失敗；無效的值以
`InvalidIntercept`
失敗，並在 cause 中保留 Schema 錯誤。這兩種情況下，該設定項目的外掛都不會啟動。請在建立載入器之前，透過宿主環境提供註冊表；載入器所管理的樹中的外掛，不能透過發布服務來註冊 Reference。預設的 CLI 註冊了
`References.CurrentLogAnnotations`（用於合併日誌註解欄位）和
`References.MinimumLogLevel`（驗證後取代日誌層級）；其他 Reference 需要由自訂的宿主註冊。直接從程式碼使用的、有型別的
`Graft.intercept` API 不受此影響。
