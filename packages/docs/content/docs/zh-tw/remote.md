---
title: 遠端外掛
description: 讓外掛在子行程或另一台機器上執行。
---

用 `@graftland/remote` 把外掛移出宿主行程。`Remote.local()`
啟動本機 Node.js 子行程，`Remote.runner(...)`
連線到另一台機器上的 runner。宿主載入的仍是一般 Graft 外掛：使用者等待服務，服務撤回時重新啟動，並在提供者之前停止。

行程分開不代表權限隔離。外掛仍能存取所在機器的檔案和網路；需要限制權限時，請在部署時使用容器或虛擬機。同一行程內的服務可見性則由[隔離](../isolation/)控制。

[remote-worker 範例](https://github.com/graftland/graft/tree/main/samples/remote-worker)
包含完整的服務、宿主、子行程和測試，不需要網路或憑證。

## 分開契約與實作

宿主只匯入契約。把實作放在另一個模組，避免宿主匯入入口時就載入或執行它：

```ts title="contract.ts"
import { Contract } from "@graftland/remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
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

啟動子行程前，先把這兩個模組編譯成 JavaScript。子行程不會使用宿主的 TypeScript
loader。

## 啟動本機子行程

```ts title="entry.ts"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

用 `Graft.plugin(entry, { greeting: "Hello" })` 或 [graft.yml](../config-file/)
載入入口。自行嵌入 Graft 時，宿主要提供 Node 平台服務，例如
`Layer.provideMerge(Graft.layer, NodeServices.layer)`。已安裝或建置好的
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
- name: ./greeter.ts
  config:
    greeting: Hello
```

入口透過 Effect Config 從環境變數讀取 runner 設定：

```ts title="greeter.ts"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem, Redacted } from "effect"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const read = (name: string) =>
		Config.String(name).pipe(Effect.flatMap((path) => fs.readFileString(path)))
	return Remote.runner({
		host: yield* Config.String("RUNNER_HOST"),
		port: yield* Config.Port("RUNNER_PORT"),
		tls: {
			servername: yield* Config.String("RUNNER_SERVERNAME"),
			ca: yield* read("RUNNER_CA"),
			cert: yield* read("RUNNER_CERT"),
			key: yield* read("RUNNER_KEY").pipe(Effect.map(Redacted.make)),
		},
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

把 `my-plugin/contract`
換成你的套件匯出的契約，宿主和 runner 安裝相符的版本。三個憑證變數都是宿主上的檔案路徑，`RUNNER_SERVERNAME`
必須與 runner 的伺服器憑證相符。設定和檔案在啟用時讀取，匯入模組時不會執行 I/O。

不傳 `instance` 時，runner
target 使用 loader 項目的 id。loader 會把產生的 id 儲存到 YAML；保留它，宿主重新啟動後就仍然對應同一個實例。明確指定的
`instance` 優先。不經過 loader 又沒傳 `instance` 時，啟用會以型別化錯誤
`MissingInstance` 失敗。

## 準備 runner

使用 Linux 或 macOS，以及 Node.js 22.22 或更新版本。在安裝目錄下預先安裝
`@graftland/remote`、編譯後的外掛套件及其依賴。網路 target 的 `contractModule`
是從該目錄解析的套件名稱或套件子路徑；宿主不會上傳程式碼。執行期間不要修改已安裝的套件。

用**專用 CA**
簽發伺服器和用戶端憑證。TLS 驗證伺服器主機名稱，並要求用戶端憑證。用戶端憑證必須恰好包含一個 SAN
URI，例如
`graft://billing`。這個身分擁有一個實例命名空間；簽發相同 URI 的憑證，就授予相同存取權。續簽時保留 URI，就能繼續存取原來的實例。

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

看到 `Listening`
日誌即表示開始監聽，其中帶有實際連接埠。狀態目錄須位於本機檔案系統，由一個 runner 獨佔。重新啟動時保留它，它記錄了實例世代和未結束的執行。不要讓仍在使用的部署身分改用空的狀態目錄。

建議用外部行程管理器執行 runner，停止時涵蓋整個行程群組或容器，包括外掛啟動的後代行程。systemd 可設
`KillMode=control-group`。runner 信任它的 CA、安裝目錄、狀態目錄和作業系統，不是執行不可信外掛的沙箱。

## 替換、租約與停止

對於同一憑證身分下的同一實例 id，一個 runner 會**先確認舊行程已退出，再接納新實例**。新實例取得更大的、持久化的 generation；runner 重新啟動復原後也遵循這個順序。無法確認退出時，它會拒絕替換，不會假定舊行程已經結束。

宿主連線期間會續租。不再續租，執行會在租約到期後停止；runner 消失也會觸發子行程停止。租約預設 15 秒，在正常排程下防止失聯的子行程無限執行。整台機器暫停時，期限檢查也會暫停，因此這不是嚴格的即時保證。檢查行程退出也仍有一個很小的 PID 重用窗口。

外掛內讀取 `Remote.Instance` 可取得
`{ id, generation }`。外部系統可以用 generation 拒絕舊實例的寫入，也就是 fencing，但必須由外部系統執行檢查。它不能撤銷已經發生的寫入，也不保證呼叫恰好執行一次；不同 runner 之間不協調 generation。本機子行程每次取得新的 id 和 generation
1，不能把它當作持久化的 fencing token。

正常停止會等待 finalizer、最後的日誌和行程退出。清理期限預設五秒。網路實例有三種可觀察的停止結果：

| 結果                           | 意義                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `Exited`                       | 走正常停止流程，並已確認行程退出。                             |
| `Killed`                       | 已確認強制終止；finalizer 不一定執行完。                       |
| `RemoteTerminationUnconfirmed` | 連線中斷，等過租約加餘裕後仍無法確認退出。逾時不等於已經退出。 |

前兩種記錄在宿主日誌的 `remote.termination` 中，同時帶有 `remote.instance` 和
`remote.generation`；第三種出現在清理失敗中。餘裕預設五秒。即使最後行程停止了，清理錯誤仍會保留。過載時日誌可能遺失，宿主會回報遺失數量。

## 熱重載

宿主入口重新求值會產生新的 Plugin 物件。[HMR](../hot-reload/)
會因此重新啟動代理、替換執行；網路實例在舊行程停止後取得新的 generation。runner 上安裝的實作模組不在宿主 HMR 圖裡。要使用新實作，先部署到 runner，再重新啟動代理。

這個套件不負責自動分發程式碼、runner 故障轉移或呼叫重播。
