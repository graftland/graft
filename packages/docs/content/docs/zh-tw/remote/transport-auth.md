---
title: 傳輸與驗證
description: 選擇宿主如何連到 runner，以及 runner 如何認出宿主。
---

runner 連線由兩部分組成：負責搬運位元組的**傳輸**，以及讓宿主取得**身分**（例如
`billing`）的**驗證**。直連的 `local` 與 `worker` 外掛兩者都沒有。

## 組合

| 傳輸                           | 驗證                            | 能防範什麼                                                                         | 警告                          |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| `url: wss://…`                 | `mtls`、`bearer`、`jwt`、`none` | 經過加密；宿主會驗證 runner 的憑證。                                               | 使用 `none` 時。              |
| `url: ws://…`                  | `bearer`、`jwt`、`none`         | 線路上什麼都不防。路徑上的任何人都能讀取、竄改流量與 token。只用於迴環位址與測試。 | 一律會有；帶 token 時更明顯。 |
| `unix: …`                      | `bearer`、`jwt`、`none`         | 能開啟 socket 檔案的人就能連線。不讀取對端的作業系統憑證。                         | 無。                          |
| `command: […]` / `stdio: true` | 不能有 `auth`，`none` 也不行    | 由命令提供，例如 SSH。                                                             | 無。                          |

其他組合在連線前就會失敗：宿主上是 `CapabilityCombinationError`，runner 上是
`ListenerConfigError`。`ws` listener 不能有 `cert` 或 `key`，`wss`
listener兩者都需要。

## 驗證選項

| 形式     | 宿主 `connect.auth`                | runner `listen[].auth`                                                                                                                                                            | 身分                                                              |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `mtls`   | `{ cert, key }` 檔案，只限 `wss`。 | `{ ca }`：用戶端憑證必須鏈結到的 CA。                                                                                                                                             | 憑證中唯一的 `graft://` URI SAN：`graft://billing` 即 `billing`。 |
| `bearer` | `{ token }`                        | `{ tokens }`：JSON 檔案 `{ "<token 的 sha256 hex>": "billing" }`。runner 從不儲存 token 本身。                                                                                    | 對應到的名稱。                                                    |
| `jwt`    | `{ token }`                        | `issuer`、`audience`（清單）、`algorithms`（只限非對稱）、`keys`（`{ publicKey: file }` 或 `{ jwksUrl }`）、`identityClaim`（預設 `sub`）、`clockTolerance`（預設 `5 seconds`）。 | 身分 claim，必須是非空字串。                                      |
| `none`   | `{}`，等同省略 `auth`              | `{ identity }`，等同省略 `auth`。不檢查任何東西。                                                                                                                                 | `identity`，預設 `anonymous`，所有呼叫端共用。                    |
| 自訂     | `{ name, config }`                 | `{ name, config }`                                                                                                                                                                | 見[能力外掛](../capabilities/)。                                  |

- 宿主以 `Authorization: Bearer <token>`
  送出 token。bearer 摘要要用確切的位元組計算：
  `printf %s "$TOKEN" | shasum -a 256`。
- JWT 必須有 `exp`；有 `nbf` 時會檢查。`clockTolerance` 可以為零。
- token 缺少或無效時，在 WebSocket 開啟前就收到帶 `WWW-Authenticate` 的 HTTP
  401。
- 用戶端憑證請用 Graft 專用的 CA：它簽發的任何帶 `graft://`
  名稱的憑證都能以該身分連線。用戶端憑證必須恰好有一個 `graft://`
  URI，可以同時有其他 URI。伺服器憑證必須符合宿主連線使用的名稱。以相同身分輪替憑證，宿主會保有原來的實例。

`graft remote certificates` 會簽發私有 CA 與憑證：

先在專案或使用者設定中啟用命令外掛：

```sh
graft add --plugin remote
```

```sh
graft remote certificates --out certs --server runner.example --identity billing
```

| 旗標         | 預設值 | 意義                                                                 |
| ------------ | ------ | -------------------------------------------------------------------- |
| `--out`      | —      | 存放 CA 與憑證的目錄。                                               |
| `--server`   | —      | runner 的 DNS 名稱或 IP，可重複。簽發 `server.crt` 與 `server.key`。 |
| `--identity` | —      | 宿主身分，可重複。簽發 `client-<identity>.crt` 與 `.key`。           |
| `--days`     | `365`  | 有效期。                                                             |
| `--force`    | 關閉   | 取代要求的憑證。沒有它時會以 `CertificateExists` 失敗。              |

第一次執行會建立 `ca.crt` 與
`ca.key`，之後沿用；CA 從不被取代。身分在檔名中會經過 URI 編碼，金鑰檔以 `0600`
權限寫入。`ca.key` 留在維運者手上；`ca.crt` 發給 runner 與各個宿主。

## 憑證來源

| 來源                     | 適用於               | 行為                                                                                                              |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 直接給值，`token: "..."` | YAML 與 TypeScript   | 原樣使用。                                                                                                        |
| `token: { file: path }`  | YAML 與 TypeScript   | 每次連線都重新讀取，因此可以輪替。整個檔案就是 token，逐位元組讀取：結尾的換行也會成為 token 的一部分。           |
| Effect                   | 只限 `Remote.plugin` | 每次連線執行一次。token 回傳 `Redacted<string>`；`mtls` 回傳 PEM 格式的 `{ cert, key }`，其中 `key` 經過 redact。 |
| `{ inject, read }`       | 只限 `Remote.plugin` | 需要服務的 Effect。其中某個服務被撤回時，遠端外掛會停止，直到服務回來。                                           |

憑證、金鑰與 CA 一律是檔案路徑，相對於設定檔。

```ts
connect: {
	url: "wss://runner.example:7443",
	instance: "greeter",
	auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
}
```

## 警告

| 訊息                                                                        | 何時出現                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ws:// listener is unencrypted`                                             | runner 啟動時，有 `ws` listener。                    |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext`   | 同上，且使用 bearer 或 JWT。                         |
| `ws:// connection is unencrypted`                                           | 宿主每次建立 `ws` 連線時。                           |
| `ws:// connection is unencrypted; credentials are transmitted in plaintext` | 同上，且宿主送出 token。                             |
| `WebSocket listener has no authentication`                                  | runner 啟動時，有使用 `none` 的網路 listener。       |
| `WebSocket connection has no authentication`                                | runner 上，每次有連線經過這種 listener 時。          |
| `Remote host authentication failed`                                         | runner 拒絕宿主憑證時，附帶 `reason`。               |
| `Remote host connection failed`                                             | runner 上連線異常結束時，附帶身分。                  |
| `Remote listener failed`                                                    | runner 上某個 listener 在啟動後失敗時。              |
| `Superseded remote execution cleanup failed`                                | runner 清理被替換的外掛行程失敗時。                  |
| `Remote logs were dropped`                                                  | 宿主上，轉送來的外掛日誌在高負載下遺失時，附帶數量。 |

Unix socket、命令與 `stdio` 從不記錄傳輸方面的警告。要消除這些警告，請改用 `wss`
並加上驗證。

## 信任與限制

- Remote 信任 runner 的安裝目錄與設定、它的作業系統與本機權限、專用 CA，以及設定的 JWT
  issuer 與金鑰。
- token 與 JWT 只在連線開啟時檢查一次。之後才到期的 JWT 不會結束已開啟的工作階段。
- 被竊的 token 在到期前都能使用。只透過 `wss`
  傳送 token，並讓 JWT 的效期保持簡短。
- `none` 只是一個名稱，不是檢查。
- 不支援：瀏覽器宿主、Web
  Worker、token 更新、工作階段中重新驗證、撤銷清單、密碼、對稱式 JWT 演算法、由代理轉送的憑證標頭、關閉 TLS 驗證、把程式碼派送到 runner、runner 容錯移轉，以及重播呼叫。
