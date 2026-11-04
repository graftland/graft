---
title: Remote
description: 讓單一外掛在子行程、Node worker 或另一台機器上執行。
---

Remote 讓外掛的程式碼在應用程式行程之外執行：放在子行程、Node worker，或
**runner**
上。runner 是在另一台機器上替宿主啟動外掛的服務。應用程式，也就是**宿主**，依然看得到外掛的[服務](../../services/)，注入這些服務的外掛不必修改。

|            | 直連：`local`、`worker` | Runner                                                  |
| ---------- | ----------------------- | ------------------------------------------------------- |
| 在哪裡執行 | 宿主上的子行程或 worker | runner 啟動的行程，通常在另一台機器上                   |
| 要安裝什麼 | 只需建置好的外掛        | 在 runner 上安裝外掛套件並執行 `graft start runner.yml` |
| 連線       | 宿主私有                | `ws`/`wss`、Unix socket，或 SSH 這類命令                |
| 驗證       | 無                      | mTLS、bearer token、JWT，或命令本身的驗證               |
| 替換外掛   | 每次啟動都是全新的行程  | 舊行程必須先退出；每次啟動都是一個 generation           |

每個載入的 `remote`
設定項目都有自己的外掛行程。停止設定項目就會停止它，重新啟動設定項目就會替換它。搬移外掛有以下限制：

- **隔離的是執行，不是權限。**
  子行程以你的使用者身分執行，worker 與宿主共用行程，runner 啟動的外掛擁有 runner 帳號的權限。需要權限邊界時，請把 runner 放進容器或虛擬機器。只想限制同一行程內外掛能看到什麼，請使用
  [realm](../../isolation/)。
- **設定必須能編碼為 JSON。** 外掛行程會自行解碼。
- **呼叫會經過連線。** 每次呼叫都是一則訊息，因連線中斷而失敗的呼叫不會重試。

## 搬移外掛

要在別處執行的外掛分成兩部分。**契約**給出外掛名稱、設定 schema 與跨越邊界的服務，雙方都會匯入它。**實作**就是外掛本身，建置為 JavaScript，只有外掛行程會匯入。

```ts title="src/contract.ts"
export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

```ts title="src/greeter.ts"
export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

`greeter` 描述 `Greeter` 如何跨越邊界，見[定義契約](../hosts/#定義契約)。把
`local: {}` 改成 `worker: {}` 或 runner 的位址，就能再次搬移外掛。
[06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote)
範例逐步示範這三種方式。
