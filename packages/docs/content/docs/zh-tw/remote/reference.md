---
title: 參考
description:
  Remote 的所有設定欄位、命令、預設值、逾時與錯誤，以及每種錯誤的處理方式。
---

本頁列出 Remote 的確切細節：設定欄位與預設值、`graft-remote`
命令、逾時，以及各種錯誤與處理方式。概念說明請從[概覽](../overview/)開始。確切的 TypeScript 簽名請見
[API 參考](../../reference/plugin-remote/readme/)。

## 慣例

- 設定檔中的**路徑**相對於包含它的檔案，而不是工作目錄。憑證、私鑰、CA、token 與
  `tokens` 檔案，以及 runner 的 `root` 與 `state` 都是如此。
- **憑證、私鑰與 CA** 一律是檔案路徑。**token** 是一個值，或用 `{ file: path }`
  從檔案讀取。
- **時間長度**是 `30 seconds`、`500 millis` 這類字串。`lease`、`grace` 與
  `margin` 必須是有限的正值；`clockTolerance` 可以為零。
- **各取其一。** 一個 `connect` 或 `listen` 元素恰好使用一種傳輸形式，最多一種
  `auth` 形式。

## 宿主項目

宿主以下列設定載入 `name: remote`：

| 欄位       | 必填 | 意義                                                                                 |
| ---------- | ---- | ------------------------------------------------------------------------------------ |
| `contract` | 是   | 契約模組：相對於設定檔的路徑、`file:` URL 或套件名稱。透過 runner 時必須是套件名稱。 |
| `connect`  | 是   | 外掛在哪裡、以什麼方式執行。見下文。                                                 |
| `config`   | 否   | 外掛的設定，採用編碼後的 JSON 形式，會以契約的 schema 驗證。預設為 `{}`。            |

YAML 項目一律使用五秒的 `shutdownTimeout`，也沒有 `retry`。修改 `config` 或
`connect` 會重新啟動遠端外掛，它從不原地更新。

### `connect` 的形式

| 形式                            | 啟動或連線到                                     | 附加欄位                                                                            |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `local: {}`                     | 宿主上的子行程。                                 | `local.command`：取代內建 `graft-remote` 執行的命令，如 `[node, /path/to/bin.js]`。 |
| `worker: {}`                    | 宿主行程中的 Node worker。                       | `worker.execArgv`：傳給 worker 的 Node 選項。                                       |
| `url: wss://…` 或 `url: ws://…` | runner 的 WebSocket listener。                   | `ca`：要信任的 CA 檔案。`servername`：取代 URL 主機名稱進行驗證的名稱。             |
| `unix: path`                    | runner 的 Unix socket。                          | —                                                                                   |
| `command: [program, args…]`     | 由命令（如 SSH）啟動、透過 stdio 溝通的 runner。 | `cwd`、`env`。                                                                      |
| `transport: { name, config }`   | [自訂 connector](../capabilities/)。             | —                                                                                   |

`local` 與 `worker` 不接受其他欄位：沒有 `auth`、`instance`、`lease`、`margin`
或 `expect`。`command` 不接受 `auth`，`none` 也不行。

### 面向 runner 的 `connect` 選項

以下選項適用於 `url`、`unix`、`command` 與 `transport`：

| 選項       | 預設值                          | 意義                                                                             |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `instance` | loader 項目的 `id`              | runner 上的實例名稱。沒有項目 id 時必須設定，否則載入以 `MissingInstance` 失敗。 |
| `lease`    | runner 的 `lease`（通常 15 秒） | 為這個實例向 runner 申請這麼長的租約。                                           |
| `margin`   | `5 seconds`                     | 在租約之外，宿主額外等待 runner 確認外掛結束的時間。                             |
| `expect`   | 不檢查                          | `{ version, digest }`，可任選其一或兩者，在外掛啟動前檢查。見下文。              |
| `auth`     | `none`                          | 宿主如何驗證。見下文。                                                           |

`expect.version` 會與 runner 上契約套件 `package.json` 中的 `version`
比對。`expect.digest` 會與套件內檔案的 SHA-256 十六進位摘要比對，摘要不包含任何
`node_modules` 目錄，因此不涵蓋依賴。只有設定了 `digest`
時 runner 才會計算它。不相符時以 `PackageError` 失敗，錯誤訊息中會列出兩個值。

### 宿主 `auth`

| 形式                  | 欄位                                        |
| --------------------- | ------------------------------------------- |
| `mtls: { cert, key }` | 用戶端憑證與私鑰檔案。僅限 `wss`。          |
| `bearer: { token }`   | `token`：一個值，或 `{ file }`。            |
| `jwt: { token }`      | `token`：一個值，或 `{ file }`。            |
| `none: {}`            | 不出示任何東西。與省略 `auth` 相同。        |
| `{ name, config }`    | [自訂 credentials](../capabilities/) 外掛。 |

`{ file }`
形式的 token 在每次連線時讀取，檔案的全部內容原樣作為 token。結尾的換行字元不會被去除，會成為 token 的一部分。宿主以
`Authorization: Bearer <token>` 的形式送出 token。

使用 `Remote.plugin` 時，`mtls`、`bearer.token` 與 `jwt.token`
也可以是一個 Effect，或是需要服務的 Effect 的 `{ inject, read }`
形式，每次連線執行一次。token 的 Effect 回傳
`Redacted<string>`；mTLS 的 Effect 回傳 PEM 格式的 `{ cert, key }`，其中 `key`
經過 redact。

## Runner 項目

runner 從傳給 `graft-remote serve` 的檔案中載入 `name: remote/runner`：

| 欄位     | 必填 | 預設值       | 意義                                                                                   |
| -------- | ---- | ------------ | -------------------------------------------------------------------------------------- |
| `root`   | 是   | —            | 安裝目錄。契約套件從它的 `node_modules` 中解析。                                       |
| `state`  | 是   | —            | 狀態目錄，不存在時自動建立。必須在本機，同一時間只供一個 runner 使用，重新啟動時保留。 |
| `lease`  | 否   | `15 seconds` | 實例的預設租約。宿主的 `connect.lease` 可為該實例覆寫。                                |
| `grace`  | 否   | `5 seconds`  | 從中斷外掛行程到強制結束它之間的時間。                                                 |
| `listen` | 是   | —            | listener 清單。見下文。                                                                |

### `listen` 的形式

| 形式                          | 欄位                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `url: ws://host:port`         | 不寫 `cert` 或 `key`。URL 的路徑必須為空或 `/graft`。                                        |
| `url: wss://host:port`        | `cert` 與 `key`：伺服器憑證與私鑰。路徑要求同上。                                            |
| `unix: path`                  | 要建立的 socket 檔案。                                                                       |
| `stdio: true`                 | `identity`：給連線進來的宿主的名稱，預設 `anonymous`。不可寫 `auth`。必須是唯一的 listener。 |
| `transport: { name, config }` | [自訂 listener](../capabilities/)。                                                          |

一個 runner 的所有 listener 共用同一組實例，所有 listener 合計最多使用一個 JWT 簽發者。

### Runner `auth`

| 形式                 | 欄位                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mtls: { ca }`       | 用戶端憑證必須鏈結到的 CA 檔案。僅限 `wss`。身分取自憑證中唯一的 `graft://` 主體別名 URI。                                                                                                                                                                                           |
| `bearer: { tokens }` | 一個 JSON 檔案，把 token 的 SHA-256 十六進位摘要對應到身分：`{ "<sha256 hex>": "billing" }`。                                                                                                                                                                                        |
| `jwt: { … }`         | `issuer`（必填）、`audience`（必填，清單）、`algorithms`（必填，僅限非對稱演算法）、`keys`（必填：`{ publicKey: file }` 或 `{ jwksUrl: url }`）、`identityClaim`（預設 `sub`）、`clockTolerance`（預設 `5 seconds`）。`exp` 必須存在；有 `nbf` 時會檢查；身分 claim 必須是非空字串。 |
| `none: { identity }` | 不做任何檢查，把 `identity`（預設 `anonymous`）指派給每個呼叫端。                                                                                                                                                                                                                    |
| `{ name, config }`   | [自訂 authenticator](../capabilities/)。                                                                                                                                                                                                                                             |

省略 `auth` 即為身分是 `anonymous` 的
`none`。缺少或無效的 bearer 與 JWT 憑證會在 WebSocket 開啟之前收到 HTTP 401 與
`WWW-Authenticate`。

## `graft-remote`

`@graftland/plugin-remote` 套件會安裝 `graft-remote` 命令。

### `graft-remote serve`

```sh
graft-remote serve --config <file>
```

以指定的設定檔執行 runner。`--config`
是它唯一的參數。檔案只讀取一次，修改後需重新啟動才會生效。日誌寫到標準錯誤。

- 所有 listener 都就緒，啟動才算完成。啟動失敗時會關閉已經開啟的資源，並帶著原因以非零狀態結束。
- `stdio`
  runner 在輸入結束時，停止外掛、確認結束並釋放狀態目錄後以狀態碼 0 結束；如果這個過程失敗，則帶著原因以非零狀態結束。

### `graft-remote certificates`

```sh
graft-remote certificates --out <dir> [--server <name>]... [--identity <name>]... [--days <n>] [--force]
```

| 參數         | 預設值 | 意義                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `--out`      | —      | 存放 CA 與所簽發憑證的目錄。                                             |
| `--server`   | —      | runner 的 DNS 名稱或 IP 位址，可重複指定多個。簽發 `server.crt`/`.key`。 |
| `--identity` | —      | 宿主身分，可重複指定多個宿主。簽發 `client-<identity>.crt`/`.key`。      |
| `--days`     | `365`  | 憑證有效期。                                                             |
| `--force`    | 關閉   | 替換所要求的伺服器與用戶端憑證。CA 永遠不會被替換。                      |

第一次執行時建立 `ca.crt` 與 `ca.key`，之後的執行會沿用它們。不加 `--force`
時，命令拒絕覆寫既有的憑證。檔名中的身分經過 URI 編碼。私鑰檔案以 `0600`
權限寫入。

`graft-remote` 的其他形式供 Remote 內部使用，不屬於公開介面。

## 逾時與預設值

| 項目                          | 預設值             | 設定方式                                    |
| ----------------------------- | ------------------ | ------------------------------------------- |
| 外掛的優雅停止                | 5 秒               | 僅限 `Remote.plugin` 的 `shutdownTimeout`   |
| 優雅停止後直連外掛的結束時間  | 1 秒               | 固定                                        |
| `local`：終止後送出 `SIGKILL` | 再過 1 秒          | 固定                                        |
| 租約                          | 15 秒              | runner 的 `lease`，或宿主的 `connect.lease` |
| 租約續約                      | 每過租約的三分之一 | 固定                                        |
| runner 上從中斷到強制結束     | 5 秒               | runner 的 `grace`                           |
| 宿主等待結束確認              | 租約 + 5 秒        | 宿主的 `connect.margin`                     |
| JWT 時鐘容許誤差              | 5 秒               | runner 的 `jwt.clockTolerance`              |
| 憑證有效期                    | 365 天             | `graft-remote certificates --days`          |

## `Remote.plugin` 選項

`Remote.plugin(contract, options)` 在 TypeScript 中建立遠端外掛。

| 選項              | 意義                                                |
| ----------------- | --------------------------------------------------- |
| `contractModule`  | 外掛行程從哪裡匯入契約。不是契約的 `module`。       |
| `connect`         | 與 YAML 相同，另外支援 Effect 形式的憑證。          |
| `config`          | 外掛設定的編碼形式。                                |
| `shutdownTimeout` | 優雅停止的時限。預設 `5 seconds`。                  |
| `retry`           | 失敗後重新啟動所用的 `Schedule`。呼叫本身從不重試。 |

## `Contract.make` 選項

| 選項       | 意義                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| `name`     | 外掛名稱。                                                                |
| `config`   | 設定 schema。必須能編碼為 JSON，且不依賴服務。                            |
| `module`   | 建置後實作的 URL，通常寫成 `new URL("./impl.js", import.meta.url).href`。 |
| `error`    | 宣告之失敗的 schema。預設 `Schema.Never`。不能依賴服務。                  |
| `inject`   | 實作要用到的宿主服務，每個都以 `Contract.service` 描述。                  |
| `provides` | 實作向宿主發布的服務，每個都以 `Contract.service` 描述。                  |

`Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述一個服務。同一契約中服務鍵必須唯一。契約模組以 `contract`
或預設匯出的形式匯出契約。

## 錯誤

### 呼叫端與 `fork.await` 看到的

| 錯誤                         | 意義                                                                      | 怎麼辦                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宣告過的錯誤                 | 外掛以契約 `error` schema 中的錯誤失敗。                                  | 像處理其他外掛錯誤一樣處理。                                                                                                                         |
| `Contract.UndeclaredFailure` | 外掛以契約未宣告的錯誤失敗，原始值在 `original` 中。                      | 在 `error` 中宣告它，或在外掛內部處理。                                                                                                              |
| `RemoteError`                | Remote 本身出錯。`cause` 中有完整的 cause，可能包含的內容見下一張表。     | 查看 `cause`。                                                                                                                                       |
| `RemoteWithdrawn`            | 外掛的服務已被撤回。                                                      | 停止與重新啟動期間屬於正常現象，消費者會先被停止。                                                                                                   |
| `MissingInstance`            | runner 連線既沒有 `connect.instance`，也沒有 loader 項目 id。             | 設定 `connect.instance`。                                                                                                                            |
| `RemoteEntryError`           | YAML 項目失敗。`entry`、`directory` 與 `field` 指出是哪個項目、哪個欄位。 | 修正該欄位。欄位包括 `contract`、`config`、`connect`、`connect.transport`、`connect.auth`，runner 上還有 `listen[n].transport` 與 `listen[n].auth`。 |

defect 仍然是 defect，Remote 不會把它們變成錯誤。

### `RemoteError` 中可能出現的

這些來自連線、外掛行程或 runner：

| 錯誤                         | 意義                                                                      | 怎麼辦                                                            |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `TransportError`             | 連線失敗，`cause` 中是底層錯誤。                                          | 檢查網路、位址與 TLS 設定。                                       |
| `CredentialsError`           | 讀取宿主憑證失敗，例如 token 檔案不存在。                                 | 檢查 `cause` 中的憑證來源。                                       |
| `ProcessExited`              | 外掛行程或 worker 意外結束，附帶結束碼與 stderr。                         | 查看 `stderr` 與 `statusCause`。                                  |
| `CommandExited`              | `command` 連線執行的程式結束了，附帶結束碼與 stderr。                     | 檢查命令本身，例如 SSH 存取與強制命令。                           |
| `CapabilityCombinationError` | 傳輸與驗證不相容，例如在 `ws` 上用 mTLS，或替 `command` 寫了 `auth`。     | 選擇支援的組合，見[選擇傳輸與驗證](../transport-auth/#所有組合)。 |
| `PackageError`               | runner 找不到、讀不了或無法驗證契約套件，或 `expect` 不相符。             | 把套件安裝到 runner 的 `root` 下，或修正 `expect`。               |
| `SessionAccessDenied`        | 工作階段屬於另一個已驗證的身分。                                          | 確保每個宿主使用自己的憑證。                                      |
| `StaleSession`               | 同一實例的另一次啟動搶先了，或 runner 已不認得這個工作階段或 generation。 | 檢查是否有兩個宿主共用同一身分與實例名稱。                        |
| `SessionConflict`            | 同一工作階段上出現互相衝突的請求。                                        | 檢查是否有兩個宿主共用同一身分與實例名稱。                        |
| `LeaseExpired`               | 宿主續約之前租約就到期了。                                                | 檢查網路；考慮加長 `lease`。                                      |
| `SessionStopped`             | 工作階段正在停止、已經停止，或在 runner 復原期間被淘汰。                  | 實例正在被替換或 runner 正在復原時屬於預期情況。                  |
| `TerminationUnconfirmed`     | runner 無法確認某個外掛行程已經結束。                                     | 在 runner 機器上檢查該行程。替換會等待確認。                      |
| `RunnerClosing`              | runner 正在關閉。                                                         | 等它恢復。                                                        |
| `StateDirectoryLocked`       | 狀態目錄已被另一個 runner 占用，或無法上鎖。                              | 每個狀態目錄只執行一個 runner。                                   |
| `StateStorageError`          | runner 無法讀寫自己的狀態。                                               | 檢查狀態目錄所在的磁碟與權限。                                    |
| `ExecutionError`             | runner 無法啟動、監看或停止外掛行程。                                     | 查看 `detail` 與 runner 的日誌。                                  |

### 清理錯誤

遠端外掛被 dispose 時，這些錯誤會出現在 `Fork.CleanupError` 的 `cause` 中：

| 錯誤                           | 意義                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `RemoteTerminationUnconfirmed` | 宿主無法取得 runner 外掛行程已結束的確認，行程可能仍在執行。                             |
| `LocalTerminationTimeout`      | `local` 子行程或 `worker` 在優雅停止後一秒內沒有結束，因此被終止。即使終止成功也會回報。 |

### runner 與能力的錯誤

| 錯誤                      | 意義                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `StartupError`            | `graft-remote serve` 無法啟動，原因見 `cause`。                            |
| `ListenerConfigError`     | listener 的傳輸與驗證不相容。                                              |
| `CapabilityContractError` | 某個能力外掛進入啟用狀態卻沒有發布它的服務。                               |
| `AuthenticationFailed`    | 宿主的憑證 `missing`（缺少）或 `invalid`（無效），以 HTTP 401 回傳給宿主。 |
| `ConformanceError`        | `@graftland/plugin-remote/Testing` 中的某項檢查失敗。                      |
| `CertificateExists`       | `graft-remote certificates` 會覆寫既有憑證。可使用 `--force`。             |

## 日誌

| 訊息                                         | 由誰記錄 | 意義                                                                      |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `Remote execution terminated`                | 宿主     | runner 上的外掛行程已停止，`remote.termination` 為 `Exited` 或 `Killed`。 |
| `Remote logs were dropped`                   | 宿主     | 負載過高時遺失了部分外掛日誌，註記中有數量。                              |
| `Remote host connection failed`              | runner   | 某條宿主連線異常結束，註記中有宿主身分。                                  |
| `Remote listener failed`                     | runner   | 某個 listener 在啟動後失敗，其他 listener 繼續執行。                      |
| `Superseded remote execution cleanup failed` | runner   | 清理被替換的外掛行程時失敗。                                              |
| 未加密與未驗證的警告                         | 雙方     | 見[警告的含義](../transport-auth/#警告的含義)。                           |

## 已發布模組

| 模組                                           | 內容                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `@graftland/plugin-remote`                     | `remote` 宿主外掛（預設匯出）、`plugin`、`Contract`、`Instance` 與公開錯誤。 |
| `@graftland/plugin-remote/runner`              | `remote/runner` 外掛（預設匯出）。                                           |
| `@graftland/plugin-remote/Contract`            | `Contract.make`、`Contract.service` 及相關型別。                             |
| `@graftland/plugin-remote/Errors`              | 錯誤類別。                                                                   |
| `@graftland/plugin-remote/Auth`、`/Transport`  | 四種能力服務。                                                               |
| `@graftland/plugin-remote/Testing`             | 共用的能力檢查。                                                             |
| `@graftland/plugin-remote/host/*`、`/runner/*` | 內建能力，見[清單](../capabilities/#內建能力模組)。                          |

`/internal/bin`、`/internal/worker` 與 `/internal/watchdog`
只是讓 Remote 找到自己的可執行檔，**不是公開 API**。runner 的 supervisor 與外掛行程執行環境同樣屬於內部實作。
