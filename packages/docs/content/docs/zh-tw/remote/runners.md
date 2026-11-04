---
title: 在另一台機器上執行外掛
description:
  部署 runner，在上面安裝外掛套件，再讓宿主透過 wss + JWT 或 SSH 連線。
---

本指南說明如何部署 runner 並讓宿主連線過去。前提是你已經像[快速上手](../getting-started/)那樣，把外掛拆成契約與實作。主線使用
`wss` 加 JWT，這也是真實網路部署通常的樣子；SSH 與 Unix socket 放在最後介紹。

## Runner 是什麼

**runner** 是用 `graft-remote serve`
啟動、供宿主連線的長期執行行程。對每一條連線，它會：

1. 確認宿主是誰（驗證）。
2. 尋找宿主指定的外掛套件。這個套件必須事先安裝在 runner 上，宿主從不傳送程式碼。
3. 為它啟動外掛行程，並在宿主用完、宿主消失，或有更新的副本取代它時停止這個行程。

runner 啟動的每個外掛都屬於一個**實例**：一個穩定的名稱，預設就是宿主設定項目的
`id`。runner 會在磁碟上維護一個小小的**狀態目錄**，記錄每個實例被替換了幾次。這為什麼重要，見[重新啟動、替換與停止](../restarts/)。

## 1. 準備機器

runner 需要：

- Linux 或 macOS，Node.js 22.22 或更新版本。
- 一個**安裝目錄**，在它的 `node_modules` 中裝好
  `@graftland/plugin-remote`、建置好的外掛套件及其依賴。runner 會依套件名稱在這裡尋找契約套件。

因為 runner 依套件名稱尋找外掛，契約要隨某個套件一起發布，並在套件的 `exports`
中匯出，例如
`my-plugin/contract`。宿主也要安裝同一個套件，因為宿主同樣要匯入契約。

runner 執行期間不要更動安裝目錄。部署新版本時，先安裝，再重新啟動用到它的外掛（見[重新部署外掛](../restarts/#重新部署外掛)）。

## 2. 準備伺服器憑證

使用 `wss`
時，宿主會驗證 runner 的 TLS 憑證，所以 runner 需要一張名稱與宿主連線位址相符的憑證。任何憑證工具都可以；`graft-remote certificates`
可以替你產生一個小型私有 CA 與伺服器憑證：

```sh
graft-remote certificates --out certs --server runner.example
```

這會寫出 `certs/ca.crt`、`certs/ca.key`、`certs/server.crt` 與
`certs/server.key`。`ca.key` 由管理者保管，`server.crt` 與 `server.key`
放到 runner 上，`ca.crt` 交給每個宿主，讓它們信任這個 runner。

## 3. 撰寫 `runner.yml`

runner 用一個 Graft 設定檔設定，其中包含一個 `remote/runner` 項目：

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          jwt:
            issuer: https://issuer.example
            audience: [graft]
            algorithms: [ES256]
            keys:
              jwksUrl: https://issuer.example/.well-known/jwks.json
```

| 欄位     | 意義                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `root`   | 第 1 步的安裝目錄。                                                                   |
| `state`  | runner 存放紀錄的地方，不存在時會自動建立。                                           |
| `listen` | 宿主從哪裡連線、如何驗證。每個位址一項。                                              |
| `auth`   | 這裡是來自你的簽發者的 JWT，以它公布的公鑰驗證。宿主的身分取自 token 的 `sub` claim。 |

所有路徑，包括 `root`、`state` 與憑證檔，都相對於
`runner.yml`，而不是啟動 runner 時所在的目錄。[選擇傳輸與驗證](../transport-auth/)介紹其他
`auth` 選項，[參考](../reference/#runner-項目)列出所有欄位與預設值。

照顧好狀態目錄：

- 它必須位於本機檔案系統。
- 同一時間只能有一個 runner 使用它。第二個 runner 使用同一目錄時，會以
  `StateDirectoryLocked` 啟動失敗。
- 重新啟動時要保留它。它記錄了替換次數，以及仍在執行的外掛行程。
- 如果某個部署的身分仍在別處使用，不要替它換上全新的空狀態目錄，否則計數會從頭開始。

## 4. 啟動 runner

```sh
graft-remote serve --config runner.yml
```

`serve` 只接受 `--config`。runner 只在啟動時讀取一次
`runner.yml`，修改後要重新啟動才會生效。

- 所有 listener 都就緒後，runner 才算啟動完成。啟動期間任何 listener 失敗，runner 會關閉已經開啟的資源，並帶著原因結束。
- 啟動之後某個 listener 失敗時，runner 記錄
  `Remote listener failed`，其他 listener 與正在執行的外掛照常運作。

請讓服務管理器在 runner 停止時一併停止它所有的後代行程，例如 systemd 的
`KillMode=control-group`。外掛行程是 runner 的後代，而 runner 本身的檢查有其侷限（見[租約](../restarts/#租約)）。

## 5. 連線宿主

在宿主上，讓 `remote` 項目指向 runner：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        jwt:
          token: { file: ./runner-token.txt }
    config:
      greeting: Hello
```

把 `RUNNER_URL` 設為 `wss://runner.example:7443`，然後啟動宿主：

```sh
graft start host.yml
```

- `contract` 現在是套件名稱。宿主從自己的安裝中匯入它，runner 在自己的 `root`
  下解析同一個名稱。
- `ca`
  是第 2 步產生的 CA。如果 runner 的憑證由宿主原本就信任的 CA 簽發，可以省略。
- `token: { file: ... }`
  會在宿主每次連線時讀取檔案，所以輪替 token 不必重新啟動。檔案的全部內容原樣作為 token：結尾的換行字元也會成為 token 的一部分，所以寫入檔案時不要帶換行。`token: "..."`
  則直接以值的形式給出 token。
- 路徑相對於 `host.yml`。

項目的 `id`，也就是
`greeter`，就是 runner 上的實例名稱。請保持它穩定：loader 會把產生的 id 儲存到設定檔裡，重新啟動後仍然有效。

### 實例名稱

實例名稱決定一條連線屬於哪個正在執行的外掛。同一實例的新連線會替換舊的外掛行程。注意以下情況：

- **兩個宿主，身分相同、實例名稱相同。**
  它們在 runner 上共用一個位置，會不斷互相替換。請給每個宿主獨立的身分，或設定不同的
  `connect.instance`。
- **同一個項目衍生出兩個遠端外掛。**
  子外掛繼承項目的 id，因此會衝突。請分別明確設定 `connect.instance`。
- **內嵌的群組。** 群組 id 只在同層之間唯一。請確認最終的名稱不會重複。
- **不經過 loader 載入。** 直接載入的 `Remote.plugin` 沒有項目 id。請設定
  `connect.instance`，否則載入會以 `MissingInstance` 失敗。

### 檢查已安裝的版本

宿主可以要求 runner 在外掛啟動前裝有指定版本：

```yaml
connect:
  url: !env RUNNER_URL
  expect:
    version: 1.4.0
```

`version` 會與契約套件 `package.json` 中的版本比對。`digest`
則比對套件內檔案的SHA-256，不含
`node_modules`，因此不涵蓋依賴。只有要求 digest 時 runner 才會計算它。不相符時以
`PackageError` 失敗，錯誤訊息中會同時列出期望值與實際值。

### 在程式碼中提供憑證

使用 `Remote.plugin` 時，憑證也可以是一個 Effect，每次連線執行一次：

```ts
import * as Remote from "@graftland/plugin-remote"
import { Config } from "effect"
import { contract } from "my-plugin/contract"

export default Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

- token 的 Effect 回傳 `Redacted<string>`。mTLS 的 Effect 回傳 PEM 格式的
  `{ cert, key }`，其中 key 經過 redact。
- 如果憑證需要某個服務，就用 `{ inject: [Vault], read: ... }`
  取代單純的 Effect。Remote 會在一個注入這些服務的子外掛中執行它；其中任何服務被撤回，遠端外掛都會停止，直到服務恢復。

## 改用 SSH 連線

如果宿主原本就能透過 SSH 存取 runner 所在的機器，可以不用網路 listener。宿主把
`ssh` 當成命令執行，透過它的標準輸入輸出與 `graft-remote serve`
溝通，驗證與加密都交給 SSH。

在 runner 上撰寫一份只有一個 `stdio`
listener 的設定，並給每個 SSH 身分獨立的狀態目錄：

```yaml title="/srv/graft/stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

在 runner 帳號的 `authorized_keys` 中，把宿主的金鑰限制為只能執行這個命令：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

在宿主上使用 `connect` 的 `command` 形式：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      command: [ssh, -T, billing@runner.example]
    config:
      greeting: Hello
```

它的行為如下：

- SSH 負責驗證宿主。`identity` 只是給宿主在 runner 上一個穩定的名稱，預設為
  `anonymous`。不要替 `command` 連線或 `stdio` listener 寫 `auth`，`none`
  也不行。
- 每個 SSH 工作階段執行各自的
  `serve`。連線結束時，它會停止外掛、確認外掛已結束、釋放狀態目錄，然後以狀態碼 0 結束。出錯時以非零狀態碼結束並回報原因。
- 同一個狀態目錄上同時出現的第二個工作階段會被拒絕。
- 標準輸出承載協定位元組，日誌寫到標準錯誤。不要配置終端機（用
  `-T`），也不要在標準輸出印出 banner。
- `stdio` listener 必須是所在 runner 唯一的 listener。
- SSH 結束並不能證明外掛行程已經停止，只有 runner 自己的確認才算數。

`command` 還接受選用的 `cwd` 與 `env` 欄位，作用於它執行的命令。

## 透過 Unix socket 連線

在同一台機器上，Unix socket 可以完全避開網路，存取權限由 socket 檔案的權限控制：

```yaml title="runner.yml"
listen:
  - unix: ./runner.sock
    auth:
      none:
        identity: billing
```

```yaml title="host.yml"
connect:
  unix: /srv/graft/runner.sock
```

`none` 不做任何檢查，直接把 `billing`
這個身分給每個連線進來的宿主。只有在檔案權限已經決定誰能連線時，這樣做才合理。Unix
socket 上也可以使用 bearer 或 JWT 驗證。

## 多個 listener

一個 `remote/runner` 項目可以有多個 `listen` 元素，例如給遠端宿主用
`wss`，給本機宿主用 Unix
socket。它們共用同一組實例：無論宿主從哪個 listener 進來，相同的身分與實例名稱都指向同一個外掛。一個 runner 的所有 listener 合計最多只能使用一個 JWT 簽發者。

## 接下來

- [選擇傳輸與驗證](../transport-auth/)：在 mTLS、bearer 與 JWT 之間選擇，並理解各種警告。
- [重新啟動、替換與停止](../restarts/)：重新部署或斷線時會發生什麼。
