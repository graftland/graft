---
title: 選擇傳輸與驗證
description: 宿主與 runner 如何連線、每種方式能防範什麼，以及各種警告的意義。
---

本頁幫助你決定宿主如何連線到 runner，以及 runner 如何知道宿主是誰。這裡說明每個選項能防範什麼、防範不了什麼，以及日誌裡的警告是什麼意思。直連的
`local` 與 `worker` 外掛不涉及這些：它們既沒有網路連線，也不需要驗證。

## 簡短的答案

| 情境                         | 選用                                      |
| ---------------------------- | ----------------------------------------- |
| 宿主透過網路存取 runner      | `wss` 搭配 JWT、mTLS 或 bearer token      |
| 已經用 SSH 管理存取權限      | `command: [ssh, ...]` 搭配 `stdio` runner |
| 宿主與 runner 在同一台機器上 | Unix socket，以檔案權限把關               |
| 在 `127.0.0.1` 上試用        | `ws` 搭配 `none`，會看到警告              |

一條連線由兩個獨立的選擇組成：

- **傳輸**負責搬運位元組：WebSocket、Unix socket，或某個命令的標準輸入輸出。
- **驗證**告訴 runner 宿主是誰，結果是一個**身分**，也就是 `billing`
  這類名稱。身分與實例名稱一起決定一條連線屬於哪個正在執行的外掛，所以身分與實例名稱都相同的兩個宿主會互相替換對方的外掛。

## 傳輸

**`wss://`**
是基於 TLS 的 WebSocket。流量經過加密，宿主會驗證 runner 的憑證：有設定 `ca`
就用它驗證，否則使用 Node 信任的 CA。需要驗證的名稱與 URL 主機名稱不同時，用
`servername` 覆寫。只要流量會經過網路，就應該使用它。

**`ws://`**
是未加密的 WebSocket。路徑上的任何人都能讀取、竄改流量，包括宿主送出的 token。只在迴環位址或測試中使用。

**`unix:`** 是同一台機器上的 Unix
socket。能開啟 socket 檔案的人就能連線，所以檔案權限就是存取控制。runner 不讀取對端的作業系統憑證。

宿主上的 **`command:`** 與 runner 上的 **`stdio: true`**
透過某個命令（通常是 SSH）的標準輸入輸出執行協定。驗證與加密都由該命令提供，所以這兩種形式完全不接受
`auth`，`none` 也不行。

WebSocket listener 只服務一個路徑 `/graft`，子協定為
`graft-remote.v1`。沒有其他 HTTP 端點，也沒有健康檢查。

## 驗證

**mTLS**（雙向 TLS）：宿主出示由 runner 信任的 CA 所簽發的用戶端憑證，身分取自憑證中的
`graft://` 名稱，`graft://billing` 即 `billing`。只能用於 `wss`。

**Bearer
token**：宿主送出一個共享密鑰。runner 從不保存 token 本身，只在一個檔案中保存它的 SHA-256 摘要到身分的對應。

**JWT**：宿主送出由你營運或使用的簽發者所簽署的 token。runner 用簽發者的公鑰或 JWKS 驗證簽章，並檢查簽發者、受眾與到期時間，再從某個 claim（預設
`sub`）取出身分。

**None**：完全不檢查。在 runner 上，`none` 給所有呼叫端同一個身分，未設定
`identity` 時為 `anonymous`。不寫 `auth` 就等於 `none`。

### Bearer token

```yaml title="host.yml"
connect:
  url: wss://runner.example:7443
  auth:
    bearer:
      token: { file: ./runner-token.txt }
```

```yaml title="runner.yml"
listen:
  - url: wss://0.0.0.0:7443
    cert: ./certs/server.crt
    key: ./certs/server.key
    auth:
      bearer:
        tokens: ./tokens.json
```

```json title="tokens.json"
{ "<sha256 hex of the token>": "billing" }
```

摘要要以 token 的確切位元組計算，例如
`printf %s "$TOKEN" | shasum -a 256`。`{ file }`
形式的 token 會原樣讀取，包括結尾的換行字元，所以 token 檔案不要以換行結尾。

### JWT

```yaml title="host.yml"
auth:
  jwt:
    token: { file: ./runner-token.txt }
```

```yaml title="runner.yml"
auth:
  jwt:
    issuer: https://issuer.example
    audience: [graft]
    algorithms: [ES256]
    keys:
      publicKey: ./issuer-public.pem
```

如果要從簽發者取得公鑰而不是讀取檔案，用
`keys: { jwksUrl: https://issuer.example/jwks }`。token 必須帶有 `exp` claim；有
`nbf` 時也會檢查；身分 claim 必須是非空字串。`clockTolerance`（預設
`5 seconds`）用來容許時鐘誤差。只接受非對稱演算法。

### mTLS

`graft-remote certificates` 可以一次簽發專用 CA、伺服器憑證與用戶端憑證：

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

| 檔案                                       | 放到哪裡              |
| ------------------------------------------ | --------------------- |
| `ca.key`                                   | 由管理者保管          |
| `ca.crt`                                   | runner 與各個宿主     |
| `server.crt`、`server.key`                 | runner                |
| `client-billing.crt`、`client-billing.key` | 名為 `billing` 的宿主 |

```yaml title="host.yml"
connect:
  url: wss://runner.example:7443
  ca: ./certs/ca.crt
  auth:
    mtls:
      cert: ./certs/client-billing.crt
      key: ./certs/client-billing.key
```

```yaml title="runner.yml"
listen:
  - url: wss://0.0.0.0:7443
    cert: ./certs/server.crt
    key: ./certs/server.key
    auth:
      mtls:
        ca: ./certs/ca.crt
```

也可以使用其他工具，規則是：伺服器憑證必須與宿主連線時使用的主機名稱相符；用戶端憑證的主體別名中必須恰好有一個
`graft://`
URI（可同時存在其他 URI）。用戶端憑證請使用 Graft 專用的 CA：它簽發的任何帶有
`graft://`
名稱的憑證，都能以該身分連線。輪替憑證時維持相同身分，宿主就能保留它的實例。

## 所有組合

| 傳輸                           | 驗證                    | 效果                                               | 警告                                                                          |
| ------------------------------ | ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `local: {}`                    | 不可寫                  | 獨立行程，擁有一般的作業系統權限。                 | 無。                                                                          |
| `worker: {}`                   | 不可寫                  | 宿主行程中的獨立執行緒。隔離執行，**不隔離權限**。 | 無。                                                                          |
| `url: wss://…`                 | mtls、bearer、jwt、none | 加密，並驗證 runner 的憑證。                       | 使用 `none` 時：runner 啟動時與每次連線時。                                   |
| `url: ws://…`                  | bearer、jwt、none       | 未加密。                                           | runner 啟動時、宿主連線時；帶 token 時措辭更嚴重。`none` 另有每次連線的警告。 |
| `unix: …`                      | bearer、jwt、none       | 由檔案權限控制存取。                               | 無。                                                                          |
| `command: […]` / `stdio: true` | 不可寫，`none` 也不行   | 取決於命令本身，例如 SSH。                         | 無。                                                                          |

表格以外的組合會在連線前失敗。mTLS 需要 `wss`；`ws` listener 不接受 `cert` 或
`key`，`wss` listener 兩者都必須提供。

## 警告的含義

| 警告                                                                      | 由誰記錄           | 意義                                                          |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `ws:// listener is unencrypted`                                           | runner，啟動時     | 網路 listener 沒有 TLS。                                      |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext` | runner，啟動時     | 同上，而且它的 token 可以在線路上被讀取。                     |
| `ws:// connection is unencrypted`（以及帶 credentials 的版本）            | 宿主，每次連線時   | 同一問題在宿主一側的表現。                                    |
| `WebSocket listener has no authentication`                                | runner，啟動時     | 網路 listener 使用 `none`：任何能存取它的人都會得到它的身分。 |
| `WebSocket connection has no authentication`                              | runner，每次連線時 | 有宿主透過這樣的 listener 連線進來。                          |

Unix socket、命令與 `stdio` 從不產生這些警告。解決方式永遠相同：改用
`wss`，並加上驗證。

## 驗證做不到的事

- **只檢查一次。** bearer
  token 與 JWT 在連線建立時檢查。缺少或無效的 token 會在 WebSocket 開啟之前收到 HTTP
  401 與 `WWW-Authenticate` 標頭。之後才過期的 JWT 不會結束已經建立的工作階段。
- **token 可以被重放。** 偷到 token 的人可以在有效期內使用它。只透過 `wss`
  傳送 token，並讓 JWT 的有效期盡量短。
- **`none` 只是一個名稱，不是檢查。** 所有呼叫端共用它的身分。

## Remote 信任什麼

Remote 信任 runner 的安裝、設定、作業系統與本機權限、專用 CA，以及設定的 JWT 簽發者與金鑰。

它不支援：瀏覽器宿主、Web
Worker、token 更新、工作階段期間重新驗證、撤銷清單、密碼、對稱 JWT 演算法、由代理轉送的憑證標頭、關閉 TLS 驗證、向 runner 散布程式碼、runner 容錯移轉，以及呼叫重放。

如果這些選項都不符合需求，可以[編寫自己的傳輸或驗證](../capabilities/)。
