---
title: 快速上手
description: 把一個外掛先移到子行程，再移到 Node worker，使用它的外掛不必修改。
---

本教學把一個外掛移出應用程式行程：先放進子行程，再放進 Node
worker。前提是你已經會寫[發布服務](../../services/)的外掛。完整程式碼見範例
[06 · 遠端外掛](https://github.com/graftland/graft/tree/main/samples/06-remote/README.zh-TW.md)。

## 起點

應用程式裡有兩個外掛：`greeter` 發布 `Greeter` 服務，`welcome` 注入它。

```ts title="src/welcome.ts"
export default Plugin.make({
	name: "welcome",
	inject: [Greeter],
	apply: () =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			yield* Effect.log(yield* greeter.greet("Alice"))
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

目標是讓 `greeter` 在另一個行程中執行，而 `welcome` 一行都不用改。

## 1. 拆分契約與實作

宿主不能匯入 greeter 的程式碼，否則這段程式碼又會在宿主裡執行。所以要把外掛拆成兩部分：

- **契約**：雙方需要約定的全部內容，包括外掛名稱、設定 schema、跨越邊界的服務，以及實作所在的位置。宿主只匯入它。
- **實作**：原本的外掛。只有外掛行程會匯入它。

服務以遠端程序呼叫（RPC）的形式跨越邊界。用 `Contract.service`
描述服務，傳入服務鍵、列出所有呼叫的 Effect `RpcGroup`，以及兩個函式：

- `toHandlers` 把真正的服務轉換為 RPC 處理函式，在服務實作所在的一側執行。
- `fromClient` 把 RPC 用戶端還原為服務介面，在使用服務的一側執行。

```ts title="src/contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("@graftland/sample-remote/contract/Greeter") {}

const api = RpcGroup.make(
	Rpc.make("Greet", {
		payload: { name: Schema.String },
		success: Schema.String,
		error: GreetingUnavailable,
	}),
)

const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client
				.Greet({ name })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						GreetingUnavailable.make({ cause }),
					),
				),
	}),
})

export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

幾點說明：

- `fromClient` 把 `RpcClientError`
  轉換成服務自己的錯誤。連線中斷時，呼叫端看到的就是他們本來就會處理的
  `GreetingUnavailable`。
- `module` 指向與建置後契約放在一起的**建置後**實作。
- `provides` 列出實作向宿主發布的服務。
- 契約以 `contract` 或預設匯出的形式匯出。

由於雙方各自解碼契約，契約要遵守幾條規則：

- 設定 schema 必須能編碼為 JSON，契約中任何 schema 在編碼、解碼時都不能依賴服務。
- 同一個契約內服務鍵必須唯一。不同服務之間的 RPC 方法名稱可以重複。
- 只有宣告過的服務才能跨越邊界。雙方的服務鍵與 RPC
  schema 必須一致，所以雙方要匯入同一個契約。

## 2. 讓實作引用契約

實作幾乎不變，只是改為從契約匯入設定 schema 與服務鍵：

```ts title="src/greeter.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

## 3. 建置為 JavaScript

外掛行程不使用宿主的 TypeScript 載入器，它匯入的是一般的 JavaScript，所以要先建置契約與實作。範例使用 tsdown：

```ts title="tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/contract.ts", "src/greeter.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
```

建置結果是 `dist/contract.js` 與 `dist/greeter.js`。兩者任一有變動都要重新建置。

## 4. 用 `name: remote` 載入

只替換 `greeter` 項目：

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

| 欄位       | 意義                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `contract` | 建置後的契約：相對於此設定檔的路徑，或 `my-plugin/contract` 這類套件名稱。 |
| `connect`  | 外掛在哪裡執行。`local: {}` 會啟動子行程。                                 |
| `config`   | 外掛自己的設定。啟動前會先用契約的 schema 驗證。                           |

`name: remote` 會載入 `@graftland/plugin-remote`
套件，所以要在應用程式中安裝它。接著啟動應用程式：

```sh
graft start
```

日誌中出現 `Hello, Alice!`，這句話現在來自子行程。

## 5. 改用 worker

只修改 `connect`：

```yaml
connect:
  worker: {}
```

問候語現在來自宿主行程內的一個 Node
worker。worker 在自己的執行緒上隔離執行，但與宿主共用行程和權限。用
`worker: { execArgv: [...] }` 傳 Node 選項給 worker；用
`local: { command: [node, /path/to/bin.js] }` 讓子行程改用其他命令啟動。

## 變了什麼，沒變什麼

以下維持不變：

- `welcome` 以及其他所有使用 `Greeter` 的外掛。
- `Greeter` 介面，以及呼叫端處理錯誤的方式。
- 外掛的生命週期：停止項目就停止外掛行程，重新啟動項目就啟動新的外掛行程。

以下不一樣了：

- **呼叫要經過連線。** 參數與結果依 RPC
  schema 編碼。因連線中斷而失敗的呼叫不會重試。
- **修改設定會重新啟動外掛。** 改動 `greeting`
  會停止外掛行程並啟動新的行程。遠端外掛從不[原地更新](../../plugins/#原地更新)。
- **修改契約需要重新啟動。**
  編輯契約後，要重新建置並重新啟動宿主，契約不參與[熱重載](../../hot-reload/)。宿主執行期間修改內層
  `config` 或 `connect` 沒有問題。
- **錯誤會被包裝。**
  外掛的失敗依[呼叫端看到的錯誤](#呼叫端看到的錯誤)所述的方式抵達宿主。

## 反方向的服務

`provides` 把服務從外掛行程送到宿主；`inject` 方向相反，列出實作需要的宿主服務。

```ts
export const contract = Contract.make({
	name: "report",
	config,
	module: new URL("./report.js", import.meta.url).href,
	inject: [database],
	provides: [reports],
})
```

這裡的 `database` 是一個 `Contract.service(Database, ...)` 描述。實作照常注入
`Database`，拿到的是一個呼叫宿主的用戶端。在宿主一側，遠端項目會像其他有依賴的外掛一樣，等到
`Database` 可用才啟動。宿主撤回 `Database` 時，遠端外掛會停止，直到它重新出現。

## 在 TypeScript 中載入

也可以不寫 YAML 項目：用 `Remote.plugin` 在程式碼中建立外掛，再用 `Graft.plugin`
載入。

```ts title="src/entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

- `contractModule` 告訴外掛行程要從哪裡匯入契約。它不同於契約自己的
  `module`，後者指向實作。
- `connect` 與 `config` 接受和 YAML 項目相同的資料。
- `shutdownTimeout` 與 `retry`
  只能在這裡設定。YAML 項目一律使用預設的五秒停止逾時，也沒有 `retry`。

`graft` 命令已經提供 Remote 需要的一切。如果你自己建立
`Graft.layer`，請在同一個環境中提供 `NodeServices.layer` 與
`SecureRandom.layerWebCrypto`；也可以在那裡提供 loader 的 `ModuleResolver` 與
`ConfigDirectory`。

## 呼叫端看到的錯誤

遠端外掛的失敗會以幾種形式抵達宿主：

| 你看到的                     | 意義                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `error` 中宣告的錯誤         | 外掛以契約宣告過的錯誤失敗。要宣告錯誤，請替契約加上 `error` schema。 |
| `Contract.UndeclaredFailure` | 外掛以契約未宣告的錯誤失敗，原始值在 `original` 中。                  |
| `RemoteError`                | Remote 本身出錯：行程結束、連線中斷、runner 拒絕等。請查看 `cause`。  |
| `RemoteWithdrawn`            | 你正在使用的外掛服務已被撤回。                                        |

defect 仍然是 defect。[參考](../reference/#錯誤)列出所有錯誤與處理方式。

## 接下來

- 讓外掛在另一台機器上執行：[在另一台機器上執行外掛](../runners/)。
- 了解重新啟動與停止時會發生什麼：[重新啟動、替換與停止](../restarts/)。
