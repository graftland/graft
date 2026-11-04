---
title: 遠端外掛
description: 讓外掛在子行程、Node worker 或 runner 上執行。
---

用 `@graftland/remote` 將外掛放到獨立執行單元中。`Remote.local()`
啟動本機 Node.js 子行程，`Remote.worker()` 啟動 Node
worker，`Remote.runner(...)`
連線到另一台機器上的 runner。宿主載入的仍是一般 Graft 外掛：使用者等待服務，服務撤回時重新啟動，並在提供者之前停止。

行程分開不代表權限隔離。外掛仍能存取所在機器的檔案和網路；需要限制權限時，請在部署時使用容器或虛擬機。同一行程內的服務可見性則由[隔離](../isolation/)控制。

[remote-worker 範例](https://github.com/graftland/graft/tree/main/samples/remote-worker)
包含完整的服務、宿主、子行程和測試，不需要網路或憑證。[remote-runner 範例](https://github.com/graftland/graft/tree/main/samples/remote-runner)
透過 wss 與 JWT 在真實 runner 上執行 `graft.yml`
條目，並示範 generation 如何拒絕過期寫入。

## 分開契約與實作

宿主只匯入契約。把實作放在另一個模組，避免宿主匯入入口時就載入或執行它：

```ts title="contract.ts"
import { Contract } from "@graftland/remote"
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

契約可以匯出為 `contract` 或
`default`，實作模組匯出一個外掛。兩邊的設定 Schema 須一致，設定須能編碼成 JSON。預期的外掛錯誤寫在契約的
`error` Schema 中。契約的 codec 不能依賴外部服務。

啟動子行程或 worker 前，先把這兩個模組編譯成 JavaScript。兩者都不會使用宿主的 TypeScript
loader。

## 載入需要的能力外掛

remote 兩端都是一般 Graft 外掛。`Remote.plugin`
依 target 注入所需能力，不會自動安裝提供者。缺少提供者時，代理保持 Pending；撤回傳輸或憑證提供者，也會撤回依賴它的代理。

公共契約模組 `@graftland/remote/Transport`、`Auth` 和 `Supervisor`
只定義服務鍵與介面，不包含實作。`Auth.Peer`
表示驗證後的身分。用 YAML 的模組名稱載入實作，或匯入其 default export 後呼叫
`Graft.plugin`：

| 位置   | `@graftland/remote/` 下的外掛路徑                                               | 用途                                                                 |
| ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 宿主   | `host/local`、`host/worker`                                                     | 建立子行程或 Node worker，不需要驗證外掛。                           |
| 宿主   | `host/websocket`、`host/unix`、`host/command`                                   | 透過選定的傳輸連線到 runner。                                        |
| 宿主   | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         | 準備選定的憑證；command 不需要這些外掛。                             |
| Runner | `runner/supervisor`                                                             | 管理執行單元、持久化 generation、租約與狀態目錄鎖定。                |
| Runner | `runner/websocket`、`runner/unix`、`runner/stdio`                               | 接受宿主工作階段；多個網路 listener 共用 supervisor 的實例命名空間。 |
| Runner | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` | 將憑證對應到穩定身分；stdio 不使用驗證器。                           |

同一 realm 中，一個服務鍵只能有一個提供者。listener 的 `auth` 填完整服務鍵，例如
`@graftland/remote/Auth/JwtAuthenticator`，不是項目 id。撤回驗證器會關閉對應的 listener，supervisor 繼續執行。

## 啟動本機子行程或 Node worker

```ts title="entry.ts"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

與入口一起載入 `host/local`：

```yaml title="graft.yml"
- name: "@graftland/remote/host/local"
- name: ./entry.ts
  config:
    greeting: Hello
```

使用 Node worker 時，將 target 改成 `Remote.worker()`，能力外掛改成
`host/worker`。它與宿主共用行程和權限；轉送的 Effect 日誌用 `remote.threadId`
識別，不使用獨立 PID。

用 `Graft.plugin(entry, { greeting: "Hello" })` 或 [graft.yml](../config-file/)
載入入口。自行嵌入 Graft 時，在建置 `Graft.layer` 的環境中提供
`NodeServices.layer` 和 `effect/crypto` 的
`SecureRandom.layerWebCrypto`；CLI 已提供這兩項服務。已安裝或建置好的
`@graftland/remote` 執行檔會負責啟動子行程。

每次啟用都有新的行程，設定變更也會重新啟動它。子行程失敗會讓宿主代理失敗；重試策略設在代理上，每次重試重新啟動行程。Effect 日誌會轉送到宿主，並帶上
`remote.pid`。請用 Effect 記錄日誌，`console.log` 不會作為結構化日誌轉送。

## 跨行程使用服務

用 `Contract.service(key, rpcGroup, mapping)` 描述服務。RPC
group 定義請求參數、結果、錯誤和串流；mapping 把這些呼叫接回平常的服務介面：

```ts
const formatter = Contract.service(Formatter, api, {
	toHandlers: (service) => ({
		Format: ({ text }: { readonly text: string }) => service.format(text),
	}),
	fromClient: (client) => ({
		format: (text) =>
			client
				.Format({ text })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						WorkerUnavailable.make({ cause }),
					),
				),
	}),
})
```

這裡的 `Formatter`、`api` 和 `WorkerUnavailable` 定義在範例的
[契約模組](https://github.com/graftland/graft/blob/main/samples/remote-worker/src/contract.ts)。轉接器把連線失敗轉成服務錯誤。請明確選擇錯誤處理方式：即使本機方法不會失敗，遠端呼叫也可能因斷線失敗。呼叫不會自動重試。

在 `Contract.make` 中列出描述符：

- `inject: [hostService]`：宿主提供服務，子行程注入它的 key。
- `provides: [formatter]`：子行程發布服務，宿主外掛注入它的 key。

只有宣告過的服務才能跨越邊界。兩邊的 key 和 RPC
Schema 必須相符。契約中的服務 key 不能重複；不同服務的 RPC 方法名稱可以相同。

正常撤回時，宿主的服務使用者先完成清理，子行程才停止。連線正常時，使用者的 finalizer 仍可呼叫遠端服務。宿主依賴消失會讓代理停止，等待依賴恢復。子行程撤回匯出的服務也會停止宿主的使用者。斷線可能中斷呼叫，因此無法保證 finalizer 中的 RPC 成功。

## 從 graft.yml 載入網路 worker

用相對路徑指向宿主入口模組。`config` 仍然只放外掛的業務輸入：

```yaml title="graft.yml"
- name: "@graftland/remote/host/websocket"
- name: "@graftland/remote/host/auth/jwt"
- id: greeter
  name: ./greeter.ts
  config:
    greeting: Hello
```

入口透過 Effect Config 從環境變數讀取 runner 設定：

```ts title="greeter.ts"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem } from "effect"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const ca = yield* Config.String("RUNNER_CA").pipe(
		Effect.flatMap((path) => fs.readFileString(path)),
	)
	return Remote.runner({
		transport: Remote.websocket({
			url: yield* Config.String("RUNNER_URL"),
			tls: { ca },
		}),
		auth: Remote.jwt(Config.Redacted("RUNNER_TOKEN")),
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

把 `my-plugin/contract` 換成你的契約匯出，宿主和 runner 安裝相符的版本。
`expect: { version, digest }` 可在啟動前強制檢查任一項或兩項。 `RUNNER_URL`
是與伺服器憑證相符的 wss URL，`RUNNER_CA` 是宿主上的 CA 檔案路徑，
`RUNNER_TOKEN` 是 JWT。設定和檔案在啟用時讀取，匯入模組不執行 I/O。

這些選項寫在 `Remote.runner({ ... })` 中，與 `transport`、`auth` 同層：

| 選項       | 預設值與用途                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance` | 預設使用 loader 項目 id，明確指定的字串優先。兩者都沒有時以 `MissingInstance` 失敗。                                                                        |
| `lease`    | 預設採用 runner 的 `--lease`，其預設值為 15 秒。宿主傳入 `"30 seconds"` 等值會覆寫該實例的 runner 預設租約。                                                |
| `margin`   | 預設 `"5 seconds"`。宿主等待終止確認時，在租約之外額外保留的時間。                                                                                          |
| `expect`   | 預設不檢查。`{ version, digest }` 可固定已安裝的套件，兩項都可省略；只有要求 digest 時才計算摘要。摘要涵蓋套件自身的檔案，排除 `node_modules`，不包含依賴。 |

loader 會把產生的項目 id 儲存到 YAML，保留它就能在宿主重新啟動後繼續對應同一個實例。
`@graftland/loader` 的 `Entry.CurrentId` 是一個值為 `Option<string>`
的 Reference；項目內 fork 的子外掛會繼承它。因此，從同一項目 fork 兩個 runner 代理、又都不寫
`instance`，就會互相替換，請為它們指定不同名稱。直接嵌入 `Group.Group`
時，id 只要求在兄弟項目之間唯一，不同 group 的 id 也可能衝突。多個宿主共用同一驗證後的身分、手動指定相同的實例名稱時，同樣會指向同一個實例。

## 選擇傳輸與驗證方式

| Target                                 | 可用驗證方式            | 保護與警告                                                                                              |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `Remote.local()`                       | 不接受 `auth`           | 獨立行程，使用正常作業系統權限；無傳輸 WARN。                                                           |
| `Remote.worker({ execArgv? })`         | 不接受 `auth`           | 與宿主共用行程，只隔離執行，**不隔離權限**；無傳輸 WARN。                                               |
| `Remote.websocket({ url: "wss://…" })` | mtls、bearer、jwt、none | 加密並驗證伺服器憑證；none 在 runner 啟動和每次連線時 WARN。                                            |
| `Remote.websocket({ url: "ws://…" })`  | bearer、jwt、none       | 不加密；runner 啟動和宿主連線時 WARN。bearer/JWT 警告明確說明憑證以明文傳輸；none 另在每次連線時 WARN。 |
| `Remote.unix({ path })`                | bearer、jwt、none       | 以檔案權限控制存取，不讀取對端憑證；無傳輸或驗證 WARN。                                                 |
| `Remote.command(argv, { cwd?, env? })` | 不接受 `auth`           | 啟動 stdio runner；驗證與加密交給命令，例如 SSH。無傳輸或驗證 WARN。                                    |

websocket、unix、command 放在 `Remote.runner({ transport, auth?, ... })`
裡。local 和 worker 是直連 target，不經過 supervisor。websocket/unix 省略 auth 等同於
`Remote.none()`，仍須載入 `host/auth/none` 和
`runner/auth/none`。它們使用 runner 設定的身分，預設
`anonymous`；所有連線的宿主共用這個命名空間。

- **mTLS：** 兩端載入 `auth/mtls`。runner 設定是
  `{ ca: "clients-ca.crt" }`。宿主用
  `Remote.mtls(Effect.succeed({ cert, key }))`，cert 是 PEM 字串，key 是包裝了 PEM 的
  `Redacted<string>`。只支援 wss。
- **Bearer：** runner 設定是
  `{ tokens: "tokens.json" }`。JSON 將 SHA-256 十六進位摘要對應到身分：
  `{ "<sha256 hex>": "billing" }`。宿主透過
  `Remote.bearer(Config.Redacted("RUNNER_TOKEN"))` 傳送原始 token。
- **JWT：** 宿主用
  `Remote.jwt(Config.Redacted("RUNNER_TOKEN"))`。runner 設定一個
  `issuer`、`audience` 清單和非空的非對稱 `algorithms` 允許清單。金鑰二選一：
  `keys: { jwksUrl: "https://issuer.example/jwks" }` 或
  `keys: { publicKey: "jwt-public.pem" }`（SPKI PEM）。 `identityClaim` 預設
  `sub`，選定 claim 的值必須是非空字串；`clockTolerance` 預設 `5 seconds`。`exp`
  必填，`nbf` 存在時驗證。
- **None：** runner 設定是
  `{ identity: "billing" }`，只是指定身分，不驗證呼叫者。

每次連線讀取一次憑證。憑證依賴服務時，可向 `Remote.jwt`、`Remote.bearer` 或
`Remote.mtls` 傳入
`{ inject: [Credentials], read: Credentials.pipe(Effect.flatMap(...)) }`，依賴會併入代理的 inject。JWT 只在 upgrade 時驗證一次，連線期間過期不會斷線。bearer/JWT 缺少或無效時，在建立 WebSocket 前回傳 401，附上
`WWW-Authenticate: Bearer`。

token 遭竊後，在有效期限內可以重播。建議使用 wss 和較短有效期限。runner 信任設定的簽發者與金鑰。不做 token 更新、連線期間重新驗證、撤銷清單、密碼驗證、對稱 JWT，也不信任代理轉送的憑證標頭。不提供關閉 TLS 驗證的選項。只支援 Node 宿主，不支援瀏覽器宿主或 Web
Worker。

WebSocket 使用 `/graft`（省略時自動補上）與 `graft-remote.v1`
子協定。沒有其他 HTTP 端點，包括健康檢查。

## 準備 runner

使用 Linux 或 macOS，以及 Node.js 22.22 或更新版本。在安裝目錄下預先安裝
`@graftland/remote`、編譯後的外掛套件及其依賴。runner 的 `contractModule`
從這裡解析套件名稱或子路徑；宿主不會上傳程式碼。執行期間不要修改已安裝的套件。

`serve --config` 載入一般 Graft 項目。以下是完整的 wss +
JWT 設定；檔案中的相對路徑以該設定檔所在目錄為基準。

```yaml title="runner.yml"
- id: remote-supervisor
  name: "@graftland/remote/runner/supervisor"
  config:
    root: /srv/graft/install
    state: /var/lib/graft
    lease: 15 seconds
    grace: 5 seconds

- id: remote-auth
  name: "@graftland/remote/runner/auth/jwt"
  config:
    issuer: https://issuer.example
    audience: [graft]
    algorithms: [ES256]
    identityClaim: sub
    clockTolerance: 5 seconds
    keys:
      publicKey: /run/secrets/jwt-public.pem

- id: public
  name: "@graftland/remote/runner/websocket"
  config:
    url: wss://0.0.0.0:7443/graft
    cert: /run/secrets/server.crt
    key: /run/secrets/server.key
    auth: "@graftland/remote/Auth/JwtAuthenticator"
```

```sh
graft-remote serve --config runner.yml
```

命令列簡寫會產生等價的 supervisor、驗證器與 listener 項目，不能與 `--config`
混用。重複 `--listen` 可啟動多個共用驗證方式的網路 listener：

```sh
# wss + mTLS
graft-remote serve --listen wss://0.0.0.0:7443 --auth mtls \
  --cert server.crt --key server.key --ca clients-ca.crt \
  --root /srv/graft/install --state /var/lib/graft

# ws + JWT (unencrypted)
graft-remote serve --listen ws://127.0.0.1:7080 --auth jwt \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft

# Unix socket + none
graft-remote serve --listen /run/graft/runner.sock --auth none --identity billing \
  --root /srv/graft/install --state /var/lib/graft

# One session over stdin/stdout
graft-remote serve --stdio --identity billing \
  --root /srv/graft/install --state /var/lib/graft
```

Bearer 使用 `--auth bearer --tokens tokens.json`。JWT 可用 `--jwt-jwks URL` 取代
`--jwt-public-key FILE`，支援重複 `--jwt-audience`、`--jwt-algorithm`，以及
`--jwt-identity-claim`、`--jwt-clock-tolerance`。驗證專用參數必須與選定方式相符。ws 不接受 cert/key，wss 兩項必填；ws 和 unix 均拒絕 mTLS。

stdio 獨佔 serve：一個行程只有一個 listener、一個工作階段，不接受
`auth`。身分預設 `anonymous`，驗證交給外部機制，例如 SSH `authorized_keys`
中的強制命令。stdout 只包含協定位元組，日誌走 stderr。stdin 結束後，先停止執行單元並確認退出，再釋放狀態目錄鎖定並正常退出；清理失敗會保留 cause，以非零狀態退出。同一狀態目錄上的第二個並行呼叫會失敗。具體設定見範例的
[SSH 說明](https://github.com/graftland/graft/blob/main/samples/remote-runner/README.zh-TW.md)。單憑 SSH 行程退出，不能認定遠端執行單元已經停止。

wss 需要伺服器憑證與受信任的 CA；mTLS 還需要由**專用 CA** 簽發用戶端憑證。可以用
`graft-remote certificates --out certs --server runner.example --identity billing`，或任何符合這些要求的工具。`ca.key`
由維運人員保管。`server.crt`/`server.key` 部署到 runner；mTLS 的
`client-billing.crt`/`client-billing.key` 部署到宿主，兩邊設定對應的
`ca.crt`。TLS 驗證伺服器主機名稱。mTLS 用戶端憑證必須恰好有一個 `graft://` SAN
URI，例如 `graft://billing`；可以同時有其他 URI
SAN。輪換憑證時保留身分，就能繼續使用原來的實例命名空間。

`--grace` 預設五秒，是 runner 請求中斷後、升級為強制終止前的等待窗口。它與宿主的
`margin`
不同：後者延長的是等待退出確認的時間，不會給外掛 finalizer 增加清理時間。

看到 `Listening`
日誌即表示開始監聽，其中帶有實際連接埠。狀態目錄須位於本機檔案系統，由一個 runner 獨佔。重新啟動時保留它，它記錄了實例世代和未結束的執行。不要讓仍在使用的部署身分改用空的狀態目錄。

建議用外部行程管理器執行 runner，停止時涵蓋整個行程群組或容器，包括外掛啟動的後代行程。systemd 可設
`KillMode=control-group`。runner 信任它的 CA、安裝目錄、狀態目錄和作業系統，不是執行不可信外掛的沙箱。

## 替換、租約與停止

對於同一驗證後的身分下的同一實例 id，一個 runner 會**先確認舊行程已退出，再接納新實例**。新實例取得更大的、持久化的 generation；runner 重新啟動復原後也遵循這個順序。無法確認退出時，它會拒絕替換，不會假定舊行程已經結束。

宿主連線期間會續租。不再續租，執行會在租約到期後停止；runner 消失也會觸發子行程停止。租約預設 15 秒，在正常排程下防止失聯的子行程無限執行。整台機器暫停時，期限檢查也會暫停，因此這不是嚴格的即時保證。檢查行程退出也仍有一個很小的 PID 重用窗口。

外掛內讀取 `Remote.Instance` 可取得
`{ id, generation }`。外部系統可以用 generation 拒絕舊實例的寫入，也就是 fencing，但必須由外部系統執行檢查。它不能撤銷已經發生的寫入，也不保證呼叫恰好執行一次；不同 runner 之間不協調 generation。本機子行程和 Node
worker 每次取得新的 id 和 generation 1，不能把它當作持久化的 fencing token。

正常停止先等待外掛 finalizer 和最後的日誌。代理的 `shutdownTimeout`
預設五秒，只約束這一步優雅 Dispose。之後才是行程終止：

- 本機子行程還有一秒完成輸出並自然退出。仍不退出時，清理會回報退出逾時並終止它；行程啟動器再等一秒後升級為 SIGKILL，並確認退出。
- Node worker 使用同樣的一秒退出窗口；逾時會記錄清理錯誤，呼叫
  `worker.terminate()` 並等待實際退出。
- 連線到 runner 的宿主最多等待協商後的租約加 `margin`
  來確認終止。runner 在強制終止之前使用自己獨立的 `--grace` 窗口。

runner 實例有三種可觀察的停止結果：

| 結果                           | 意義                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `Exited`                       | 走正常停止流程，並已確認行程退出。                                                                     |
| `Killed`                       | 已確認強制終止；finalizer 不一定執行完。                                                               |
| `RemoteTerminationUnconfirmed` | 等過租約加餘裕後仍無法確認退出；既可能是斷線，也可能是連線仍在但 runner 無法確認。逾時不等於已經退出。 |

前兩種記錄在宿主日誌的 `remote.termination` 中，同時帶有 `remote.instance` 和
`remote.generation`；第三種出現在清理失敗中，可用匯出的
`Remote.RemoteTerminationUnconfirmed`
辨識。即使最後行程停止了，清理錯誤仍會保留。過載時日誌可能遺失，宿主會回報遺失數量。

宿主正常斷線會結束工作階段，不記 ERROR。異常斷線記 Warning，包含 cause 與對端身分，runner 繼續服務。執行單元由 Dispose 和租約決定何時停止，不由連線本身決定。

## 處理失敗

代理除了暴露契約中宣告的錯誤，還可能回報：

- `Remote.Contract.UndeclaredFailure`：實作拋出了契約之外的錯誤，`original`
  保留診斷值。
- `Remote.RemoteWithdrawn`：子行程撤回了匯出的服務，宿主的服務使用者需要停止。
- `Remote.RemoteError`：啟動或基礎設施失敗，`cause` 保留具體原因。
- `Remote.MissingInstance`：既沒有明確指定實例名稱，也沒有 loader 項目 id。

這些屬於啟用或背景失敗。明確呼叫 dispose 則回報 `Fork.CleanupError`；在它的
`cause` 裡檢查清理與終止錯誤，包括
`Remote.RemoteTerminationUnconfirmed`。非預期 defect 仍是 defect，逾時不會把清理變成成功。

## 熱重載

宿主入口重新求值會產生新的 Plugin 物件。[HMR](../hot-reload/)
會因此重新啟動代理、替換執行；runner 實例在舊行程停止後取得新的 generation。runner 上安裝的實作模組不在宿主 HMR 圖裡。要使用新實作，先部署到 runner，再重新啟動代理。

這個套件不負責自動分發程式碼、runner 故障轉移或呼叫重播。
