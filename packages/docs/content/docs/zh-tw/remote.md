---
title: 遠端外掛
description: 在子行程、Node worker 或 runner 上執行外掛。
---

用 `name: remote` 讓外掛在宿主之外執行。可以選本機子行程、Node
worker，或連線到 runner。消費者仍然注入一般的 Graft 服務；提供者撤回時，它們也會停止。

Remote 隔離的是執行，不是權限。需要權限邊界時請用容器或虛擬機；同一行程內的服務可見性用[隔離](../isolation/)控制。[06 · 遠端外掛](https://github.com/graftland/graft/tree/main/samples/06-remote)示範 local 和 worker；[chat-bot 範例](https://github.com/graftland/graft/tree/main/samples/chat-bot)把天氣整合放進子行程。

## 定義契約

宿主只匯入契約。契約的 `module`
指向另一個實作模組，由它匯出一般的 Graft 外掛。啟動子行程或 worker 前，先將兩者建置為 JavaScript；它們不會使用宿主的 TypeScript
loader。

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract: Contract.Contract<typeof config, typeof Schema.Never> =
	Contract.make({
		name: "greeter",
		config,
		error: Schema.Never,
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
`error` schema。

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

## 跨邊界使用服務

以 `Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述服務，再放入 `Contract.make`：

- `inject`：實作需要的宿主服務。
- `provides`：實作提供給宿主消費者的服務。

只有已宣告的服務會跨邊界。服務鍵和 RPC
schema 必須一致；同一契約內的服務鍵不可重複，不同服務的 RPC 方法名稱可以重複。[範例契約](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)示範如何在
`fromClient` 將 `RpcClientError` 轉成服務自己的錯誤。

正常撤回時先結束消費者；連線正常時，finalizer 仍能呼叫遠端服務。宿主依賴撤回會停止代理，依賴回來後再恢復。子外掛撤回匯出的服務，也會停止宿主消費者。連線故障可能中斷呼叫與 finalizer。

## 設定 runner

在 Linux 或 macOS 使用 Node.js
22.22 或更新版本。安裝 remote、已建置的外掛套件與依賴。runner 在 `root`
下解析契約套件名稱，宿主不會上傳程式碼；執行期間不要更動安裝目錄。建議由外部 supervisor 管理 runner 及所有後代行程，例如 systemd 的
`KillMode=control-group`。

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

`serve` 只接受 `--config`。一個 runner
entry 管理一個 supervisor 與所有 listener，共用實例命名空間。所有 listener 就緒才算啟動成功；啟動失敗會關閉已開啟的資源，執行期間某個 listener 失敗則不會停止其他 listener 或 supervisor。一個 runner 只能設定一個 JWT 簽發者；宣告 issuer 的第三方驗證器也受此限制。bearer 的 token 檔案不算簽發者。

每個 entry 都有私有的能力提供者。同一種能力可在兩個 entry 使用不同設定。第三方外掛寫成
`transport: { name: "my-connector", config: {...} }` 或
`auth: { name: "my-authenticator", config: {...} }`。name 依應用程式的 loader 規則解析；內建簡寫也會展開成相同的引用。

wss 需要伺服器憑證和受信任的 CA；mTLS 客戶端憑證由專用 CA 簽發：

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

也能使用其他工具。管理者保管
`ca.key`；伺服器憑證與私鑰部署到 runner，`client-billing.crt`/`.key`
部署到宿主，兩邊都需要
`ca.crt`。伺服器憑證須符合主機名稱。mTLS 客戶端憑證須有恰好一個 `graft://` SAN
URI，例如 `graft://billing`；允許其他 URI
SAN 共存。輪替憑證時維持相同身分，就能保留實例命名空間。

`state`
必須放在本機檔案系統，同一時間只能由一個 supervisor 持有。跨重啟保留目錄，其中記錄了 generation 與未完成的執行。不要用空白狀態目錄重用仍在執行的部署身分。

## 選擇傳輸與驗證

| `connect` / runner listener    | 驗證                           | 保證與 WARN                                                                                       |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `local: {}`                    | 不可寫 `auth`                  | 獨立行程，一般 OS 權限；無傳輸 WARN。                                                             |
| `worker: {}`                   | 不可寫 `auth`                  | 與宿主同一行程，只隔離執行，**不隔離權限**；無傳輸 WARN。                                         |
| `url: wss://…`                 | mtls、bearer、jwt、none        | 加密，驗證伺服器憑證。none 在 runner 啟動與每次連線時 WARN。                                      |
| `url: ws://…`                  | bearer、jwt、none              | 不加密。runner 啟動、宿主連線時 WARN；使用 token 時明確提示憑證以明文傳輸。none 也會逐連線 WARN。 |
| `unix: …`                      | bearer、jwt、none              | 依賴檔案權限，不讀取對端憑證；無傳輸或驗證 WARN。                                                 |
| `command: […]` / `stdio: true` | 不可明確寫 `auth`，none 也不行 | 驗證與加密由 SSH 等外部命令負責。                                                                 |

省略 auth 就是 none，runner 預設身分是
`anonymous`。網路 listener 會 WARN，所有呼叫者共用這個身分。mTLS 僅支援 wss。ws 不寫 cert/key，wss 必須同時寫兩者。WebSocket 路徑為
`/graft`，子協定為 `graft-remote.v1`；沒有其他 HTTP 端點或健康檢查。

- **Bearer**：宿主 `auth: { bearer: { token: "value" } }`；runner
  `auth: { bearer: { tokens: "./tokens.json" } }`。檔案將 SHA-256 十六進位摘要對應到身分：`{ "<sha256 hex>": "billing" }`，不儲存明文 token。
- **JWT**：宿主 `auth: { jwt: { token: { file: "./token.txt" } } }`。runner 使用
  `auth: { jwt: { issuer: "https://issuer.example", audience: [graft], algorithms: [ES256], keys: { publicKey: "./public.pem" } } }`；JWKS 則用
  `keys: { jwksUrl: "https://issuer.example/jwks" }`。`identityClaim` 預設
  `sub`，`clockTolerance` 預設 `5 seconds`。身分 claim 必須是非空字串，`exp`
  必填，存在 `nbf` 時也會驗證。
- **None**：runner 的 `auth: { none: { identity: billing } }`
  只指定名稱，不驗證呼叫者。

缺少或無效的 bearer/JWT 在 upgrade 前回傳 401 與
`WWW-Authenticate`。JWT 只在此時驗證，連線期間過期不會斷線。token 被竊後，在有效期內可以重放；建議用 wss 與較短的有效期。

stdio 只寫一個 `listen`
元素：`{ stdio: true, identity: billing }`，不可與其他 listener 共存。stdout 只寫協定位元組，日誌送到 stderr。EOF 後先停止執行單元、確認退出、釋放狀態鎖，再以 0 退出；清理失敗保留 cause 並以非零代碼退出。同一狀態目錄的並行呼叫會失敗。驗證交給 SSH
`authorized_keys` 強制命令等外部機制。SSH 退出本身不代表遠端執行單元已退出。

Remote 信任 runner 的安裝、設定、OS、本機權限、專用 CA，以及設定的 JWT 簽發者與金鑰。不支援瀏覽器宿主、Web
Worker、token 更新、連線期間重新驗證、撤銷清單、密碼、對稱 JWT、代理轉送的憑證標頭、關閉 TLS 驗證、程式碼散布、runner 容錯移轉或呼叫重放。

## 透過 SSH 連線

在 runner 上安裝外掛套件，為這個 SSH 身分使用獨立的狀態目錄。設定裡只放一個 stdio
listener：

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

宿主使用 command 形式的 `connect`，YAML 也能寫相同的陣列：

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

在 runner 帳號的 `authorized_keys`
裡，把這個公鑰限定為固定命令。請換成實際部署的執行檔路徑與公鑰：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

不要配置終端，也不要把歡迎訊息寫到 stdout，它只承載協定位元組。SSH 驗證宿主身分，`identity`
指定穩定的 runner 身分名稱。同一狀態目錄不允許第二個呼叫同時執行。SSH 退出不等於執行單元已停止。

## 替換與停止

對同一驗證身分與 instance，runner
**確認舊行程退出後**才接受新實例。generation 會持久保存並遞增，runner 復原後也成立。無法確認退出就拒絕替換。外掛從
`Remote.Instance` 讀取
`{ id, generation }`；外部系統可以拒絕舊 generation 的寫入，也就是 fencing，但必須自行檢查。它不會撤銷已完成的寫入，不保證呼叫恰好一次，也不協調不同 runner。local/worker 每次都是新 id、generation
1。

宿主持續續租；停止續租後執行單元到期退出，runner 消失也會觸發退出。整台機器暫停會暫停期限執行，因此不是硬即時保證；行程身分檢查還有很窄的 PID 重用窗口。後代行程仍由外部 supervisor 負責。

停止先執行優雅 Dispose。`shutdownTimeout` 預設五秒，只限制這一步。之後：

- 本機子行程再有一秒自然退出；逾時後強制終止，spawner 再過一秒升級為 SIGKILL 並確認退出。
- worker 同樣等一秒，接著 `worker.terminate()`
  並等待執行緒確實退出。即使終止成功，逾時仍記入清理錯誤。
- runner 連線最多等待租約加宿主 `margin`。runner 的 `grace`
  預設五秒，是從中斷到強制終止的窗口；`margin` 只是宿主額外等待確認的時間。

| 結果                           | 意義                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `Exited`                       | 正常停止，已確認行程退出。                                                 |
| `Killed`                       | 已確認強制終止，finalizer 可能未完成。                                     |
| `RemoteTerminationUnconfirmed` | 退出未確認，可能已斷線，也可能仍連線但 runner 無法確認。逾時不是退出證明。 |

前兩種寫入附有 instance、generation 的 `remote.termination`
日誌，第三種是清理錯誤。正常斷線不記 ERROR，異常連線記錄帶有 cause 和身分的 Warning。執行壽命由 Dispose 與租約決定，不只取決於連線。負載過高可能遺失日誌，宿主會回報數量。

TS 代理暴露已宣告的錯誤、`Contract.UndeclaredFailure`、`RemoteWithdrawn`、含 cause 的
`RemoteError` 與 `MissingInstance`。dispose 回傳
`Fork.CleanupError`，可在其 cause 尋找
`RemoteTerminationUnconfirmed`。defect 仍是 defect。YAML 錯誤也會標示 entry 與失敗欄位。

## 熱重載

宿主 entry 重載會替換執行單元，runner 確認舊實例退出後才增加 generation。**修改契約後需要重啟宿主**；原始契約匯入不參與 HMR。runner 的實作模組不在宿主 HMR 圖中，請在 runner 部署，再重啟代理。

## 撰寫能力外掛

[能力作者指南](../remote-capabilities/)介紹四個服務契約、握手與可重用的符合性測試。內建
`host/*`、`runner/*` 也實作相同的契約；應用程式不必將它們逐一寫成 entry。
