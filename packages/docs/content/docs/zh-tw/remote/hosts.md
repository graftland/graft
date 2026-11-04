---
title: 宿主設定項目
description: 用契約描述遠端外掛，並從 YAML 或 TypeScript 載入它。
---

宿主透過契約載入遠端外掛。契約是宿主唯一會匯入的模組，實作則在外掛行程中執行。

## 定義契約

用 `Contract.service` 描述每個跨越邊界的服務：它的鍵、列出各個呼叫的 Effect
`RpcGroup`，以及兩個函式。

```ts title="src/contract.ts"
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
```

`toHandlers` 在實作服務的一側執行，`fromClient` 在使用服務的一側執行。請在
`fromClient` 中轉換
`RpcClientError`，讓連線中斷以呼叫端本來就會處理的錯誤出現。接著把這份描述交給
`Contract.make`：

| 欄位       | 意義                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `name`     | 外掛名稱。                                                              |
| `config`   | 設定 schema，必須能編碼為 JSON。                                        |
| `module`   | 建置後實作的 URL，通常是 `new URL("./impl.js", import.meta.url).href`。 |
| `error`    | 外掛宣告的失敗的 schema，預設為 `Schema.Never`。                        |
| `inject`   | 實作使用的宿主服務。                                                    |
| `provides` | 實作發布給宿主的服務。                                                  |

- 契約中的 schema 都不能需要服務才能編碼或解碼。
- 服務鍵在同一份契約內必須唯一；RPC 名稱可以在不同服務間重複。
- 以 `contract` 或預設匯出的形式匯出契約。
- 雙方匯入同一份建置後的契約，所以鍵與 RPC schema 一致。

## 從 YAML 載入

把外掛的設定項目換成 `remote` 設定項目。`name: remote` 會載入
`@graftland/plugin-remote`，所以請在應用程式中安裝它。

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

| 欄位       | 意義                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `contract` | 相對於設定檔的路徑、`file:` URL 或套件名稱。透過 runner 時只能是套件名稱。                |
| `connect`  | 外掛在哪裡執行，取下列其中一種形式。                                                      |
| `config`   | 外掛自己的設定，採編碼後的 JSON 形式，在任何東西啟動前依契約的 schema 檢查。預設為 `{}`。 |

| `connect` 形式                | 外掛執行於                           | 其他欄位                                                                                   |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `local: {}`                   | 宿主上的子行程。                     | `local.command` 取代內附的 內部 child 入口，例如 `[node, /path/to/childMain.js]`。         |
| `worker: {}`                  | 宿主行程中的 Node worker。           | `worker.execArgv`：傳給 worker 的 Node 選項。                                              |
| `url: wss://…` 或 `ws://…`    | runner 的 WebSocket listener。       | `ca`：改為信任的 CA 檔案，取代 Node 信任的 CA。`servername`：取代 URL 主機名稱的驗證名稱。 |
| `unix: path`                  | runner 的 Unix socket。              | —                                                                                          |
| `command: [program, args…]`   | 由命令（例如 SSH）啟動的 runner。    | `cwd`、`env`。                                                                             |
| `transport: { name, config }` | [自訂 connector](../capabilities/)。 | —                                                                                          |

- `local` 與 `worker` 不接受其他欄位：沒有 `auth`、`instance`、`lease`、`margin`
  或 `expect`。
- runner 形式另外接受 `auth`（[傳輸與驗證](../transport-auth/)）、`instance` 與
  `expect`（[Runner](../runners/#實例)），以及 `lease` 與
  `margin`（[替換與停止](../lifecycle/#逾時與預設值)）。
- 路徑相對於設定檔，而不是工作目錄。
- YAML 設定項目的 `shutdownTimeout` 固定為 5 秒，且沒有 `retry`。

## 從 TypeScript 載入

`Remote.plugin` 在程式碼中建立同樣的外掛，交給 `Graft.plugin` 載入：

```ts title="src/entry.ts"
const greeter = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	shutdownTimeout: "5 seconds",
})

const fork = yield * Graft.plugin(greeter, { greeting: "Hello" })
yield * fork.await
yield * fork.update({ greeting: "Hi" })
yield * fork.await
```

工廠只固定部署選項。業務設定傳給 `Graft.plugin`；呼叫 `fork.update`
會先停止舊執行單元，再用新設定啟動新的執行單元。

| 選項              | 意義                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `contractModule`  | 外掛行程從哪裡匯入契約。不是契約自己的 `module`。                  |
| `connect`         | 與 YAML 相同，另外可用[憑證 Effect](../transport-auth/#憑證來源)。 |
| `shutdownTimeout` | 優雅停止的時限，預設 `5 seconds`。                                 |
| `retry`           | 外掛失敗後重新啟動用的 `Schedule`。呼叫本身從不重試。              |

`graft start` 會提供 Remote 需要的一切。如果你自己建立
`Graft.layer`，請在它的環境中提供 `NodeServices.layer` 與
`SecureRandom.layerWebCrypto`，也可以一併提供 loader 的 `ModuleResolver` 與
`ConfigDirectory`。

## 跨越邊界的服務

| 規則             | 說明                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| **Provides**     | 實作用 `Graft.provide` 發布這些服務，宿主外掛照常注入。                    |
| **Inject**       | 實作注入這些宿主服務，拿到的是會呼叫宿主的 client。                        |
| **等待**         | `remote` 設定項目會像任何有相依的外掛一樣，等待它的 `inject` 服務。        |
| **宿主撤回**     | `inject` 中的宿主服務被撤回時，遠端外掛會停止，直到服務回來。              |
| **外掛撤回**     | 宿主上的使用者會停止。撤回之後的呼叫以 `RemoteWithdrawn` 失敗。            |
| **停止順序**     | 使用者先於服務撤回而停止，與[撤回流程](../../services/#服務撤回流程)相同。 |
| **連線中斷**     | 隨時可能中斷呼叫與 finalizer。                                             |
| **只限已宣告的** | 契約沒有列出的服務不會跨越邊界。                                           |

## 呼叫端看到的錯誤

呼叫端與 `fork.await` 會看到這些錯誤：

| 錯誤                         | 意義                                                                     | 該怎麼做                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 已宣告的錯誤                 | 外掛以契約 `error` schema 中的錯誤失敗。                                 | 像處理任何外掛錯誤一樣處理。                                                                                                                 |
| `Contract.UndeclaredFailure` | 外掛以未宣告的錯誤失敗，`original` 保存它。                              | 在 `error` 中宣告它，或在外掛內處理。                                                                                                        |
| `RemoteError`                | Remote 本身失敗。`cause` 保存錯誤；runner 的錯誤也會出現在這裡，見下表。 | 讀取 `cause`。                                                                                                                               |
| `RemoteWithdrawn`            | 外掛的服務在使用中被撤回。                                               | 停止與重新啟動期間屬於正常現象。                                                                                                             |
| `MissingInstance`            | runner 連線既沒有 `connect.instance`，也沒有設定項目 id。                | 設定 `connect.instance`。                                                                                                                    |
| `RemoteEntryError`           | YAML 設定項目無效。`entry`、`directory` 與 `field` 指出位置。            | 修正該 `field`：`contract`、`config`、`connect`、`connect.transport`、`connect.auth`，或 runner 的 `listen[n].transport`、`listen[n].auth`。 |

上表的公開錯誤都從套件根匯出。defect 仍然是 defect。以下巢狀標籤是
`RemoteError.cause` 帶有的診斷資訊：

| 錯誤                         | 意義                                                         | 該怎麼做                                  |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `TransportError`             | 連線失敗，`cause` 保存底層錯誤。                             | 檢查網路、位址與 TLS 設定。               |
| `CredentialsError`           | 讀取宿主憑證失敗，例如 token 檔案不存在。                    | 檢查 `cause` 中的來源。                   |
| `ProcessExited`              | 外掛行程或 worker 意外退出，附帶結束代碼與 stderr。          | 查看 `stderr` 與 `statusCause`。          |
| `CommandExited`              | `command` 的程式退出，附帶結束代碼與 stderr。                | 檢查 SSH 存取與強制命令。                 |
| `CapabilityCombinationError` | 傳輸與驗證搭配不起來，例如在 `ws` 上用 mTLS。                | 見[組合](../transport-auth/#組合)。       |
| `PackageError`               | runner 找不到、讀不到或無法驗證契約套件，或 `expect` 不符。  | 把套件安裝到 `root` 下，或修正 `expect`。 |
| `SessionAccessDenied`        | 這個工作階段屬於另一個身分。                                 | 讓每個宿主使用自己的憑證。                |
| `StaleSession`               | 同一實例的另一次啟動搶先了，或 runner 已不認得這個工作階段。 | 檢查是否有兩個宿主共用身分與實例。        |
| `SessionConflict`            | 同一工作階段上的請求互相衝突。                               | 同上。                                    |
| `LeaseExpired`               | 宿主續約前租約就到期了。                                     | 檢查網路，或使用更長的 `lease`。          |
| `SessionStopped`             | 工作階段正在停止、已經停止，或在 runner 復原時被淘汰。       | 替換或復原期間屬於預期。                  |
| `TerminationUnconfirmed`     | runner 無法確認外掛行程已退出。                              | 檢查 runner 機器。替換會等待確認。        |
| `RunnerClosing`              | runner 正在關閉。                                            | 等它回來。                                |
| `StateDirectoryLocked`       | 另一個 runner 擁有這個狀態目錄，或目錄無法鎖定。             | 每個狀態目錄只跑一個 runner。             |
| `StateStorageError`          | runner 無法讀寫自己的狀態。                                  | 檢查磁碟與權限。                          |
| `ExecutionError`             | runner 無法啟動、監看或停止外掛行程。                        | 查看 `detail` 與 runner 的日誌。          |

## 設定變更與熱重載

| 修改內容                                               | 結果                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 透過 `fork.update` 或 YAML 修改業務設定                | 執行單元重新啟動，不會原地更新。                                                                                 |
| YAML 中的 `connect`                                    | 先停止舊執行單元，再建立新連線。                                                                                 |
| `graft start --watch` 下 local/worker 的契約或實作檔案 | 對應的遠端 fork 以新程式碼重新啟動，也會觀察契約匯入的相依模組。入口指向建置後的 JavaScript 時，需要先重新建置。 |
| 網路 runner 上的實作                                   | 宿主不觀察它。在 runner 安裝新程式碼，再重新啟動設定項目。                                                       |

即使匯入、契約驗證或啟動失敗，觀察也會保留到項目被移除或停用。修正已知的契約、相依模組或實作檔案會重試項目；成功匯入後會取代舊的相依集合。監看器失敗會記錄日誌並重試，仍以原先的檔案摘要比較，因此復原期間的修改也會觸發重新啟動。

未啟用 `--watch` 時，重新建置契約後需要重新啟動宿主。
