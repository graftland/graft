---
title: 宿主
description: 從 YAML 或 TypeScript 載入遠端外掛時看這一頁。
---

從 YAML 或 TypeScript 載入遠端外掛時看這一頁。這裡介紹契約、連線設定，以及跨邊界使用服務的方式。

## 定義契約

宿主只匯入契約。契約的 `module`
指向另一個實作模組，由它匯出一般的 Graft 外掛。啟動子行程或 worker 前，先將兩者建置為 JavaScript；它們不會使用宿主的 TypeScript
loader。

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./worker.js", import.meta.url).href,
})
```

```ts title="worker.ts"
import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config } from "./contract.js"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
```

契約可匯出為 `contract` 或
`default`。設定必須能編碼為 JSON，契約的 codec 不能依賴外部服務。預期內的失敗放在契約的
`error` schema；省略時預設為 `Schema.Never`。

## 從 YAML 或 TypeScript 載入

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

執行 `graft start`，不必另外寫能力 entry 或服務鍵字串。要用 Node worker，將
`local: {}` 換成 `worker: {}`。TS 使用相同的 `connect` 資料與業務 `config`：

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

以 `Graft.plugin(entry)` 載入。`contractModule`
告訴子行程或 runner 到哪裡讀契約，與契約內指向實作的 `module`
不同。自行嵌入 Graft 時，在建構 `Graft.layer` 的環境提供 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`；CLI 已提供。也能在這裡提供 loader 的
`ModuleResolver` 與 `ConfigDirectory`。

連線到 runner 時，兩邊都要安裝契約套件：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        mtls:
          cert: ./certs/client-billing.crt
          key: ./certs/client-billing.key
      lease: 30 seconds
    config:
      greeting: Hello
```

將 `RUNNER_URL` 設為 `wss://runner.example:7443`，再執行
`graft start --config host.yml`。相對路徑以設定檔所在目錄為準，不是 cwd。憑證、私鑰、CA 的字串都是檔案路徑；token 字串是值本身，讀檔要寫
`{ file: "./token.txt" }`。同一處只能選一種傳輸與一種驗證寫法。

`connect` 也支援
`unix: /run/graft.sock`、`command: [ssh, runner.example, graft-remote, serve, --config, /srv/stdio.yml]`、`local: { command: [node, /path/to/bin.js] }`
和 `worker: { execArgv: [] }`。command 還可設定 `cwd` 與 `env`。

TS 額外允許以 Effect 讀取憑證，每次連線讀取一次：

```ts
import { Config } from "effect"

Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

憑證來自服務時，可將 Effect 換成
`{ inject: [Vault], read: Vault.pipe(...) }`。token Effect 回傳
`Redacted<string>`；mTLS Effect 回傳含有 PEM 的
`{ cert: string, key: Redacted<string> }`。Remote 為它建立憑證子外掛，明確注入這些依賴；依賴撤回就會停止代理。`retry`
放在 `Remote.plugin` 的選項中；RPC 呼叫不會自動重試。

| `connect` 選項 | 預設值與意義                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`     | loader 條目 id；明確指定的值優先。兩者都沒有時，以 `MissingInstance` 失敗。                                                                    |
| `lease`        | runner 預設值，通常是 15 秒。宿主可為這個實例覆寫。                                                                                            |
| `margin`       | 5 秒；在租約之外多等這段時間，取得退出確認。                                                                                                   |
| `expect`       | 預設不檢查。`{ version, digest }` 可在啟用前強制檢查版本、摘要或兩者。摘要只在要求時運算，涵蓋套件自身除 `node_modules` 外的檔案，不涵蓋依賴。 |

loader 會把產生的條目 id 寫回 YAML，重啟時請保留。子外掛繼承
`Entry.CurrentId`：同一條目 fork 出兩個 runner 代理時，要明確給它們不同的 instance，否則會互相替換。直接嵌入的
`Group.Group`
只要求同層 id 唯一。多個宿主共用驗證身分與 instance 名稱時，也會操作同一個 runner 實例。

## 自訂能力

自訂能力可寫成 `connect.transport: { name: "my-connector", config: {...} }` 與
`connect.auth: { name: "my-credentials", config: {...} }`。name 依應用程式的 loader 規則解析，詳見[能力外掛](../capabilities/)。

## 跨邊界使用服務

以 `Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述服務，再放入 `Contract.make`：

- `inject`：實作需要的宿主服務。
- `provides`：實作提供給宿主消費者的服務。

只有已宣告的服務會跨邊界。服務鍵和 RPC
schema 必須一致；同一契約內的服務鍵不可重複，不同服務的 RPC 方法名稱可以重複。[範例契約](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)示範如何在
`fromClient` 將 `RpcClientError` 轉成服務自己的錯誤。

正常撤回時先結束消費者；連線正常時，finalizer 仍能呼叫遠端服務。宿主依賴撤回會停止代理，依賴回來後再恢復。子外掛撤回匯出的服務，也會停止宿主消費者。連線故障可能中斷呼叫與 finalizer。

## 熱重載

宿主 entry 重載會替換執行單元，runner 確認舊實例退出後才增加 generation。**修改契約後需要重啟宿主**；原始契約匯入不參與 HMR。runner 的實作模組不在宿主 HMR 圖中，請在 runner 部署，再重啟代理。

關閉期限與失敗回報見[替換、租約與停止](../lifecycle/)。
