---
title: 傳輸與驗證
description: 部署前，在這裡選擇傳輸與驗證方式。
---

部署前，在這裡選擇傳輸與驗證方式。本頁列出支援的組合、何時出現 WARN，以及各自的邊界。

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

## mTLS 憑證

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

客戶端 `auth.mtls`
的寫法見[宿主設定](../host/#從-yaml-或-typescript-載入)，伺服器端見
[runner 設定](../runner/#設定-runner)。command 連線請依
[SSH/stdio 部署說明](../runner/#透過-ssh-連線)設定。

## 信任與限制

Remote 信任 runner 的安裝、設定、OS、本機權限、專用 CA，以及設定的 JWT 簽發者與金鑰。不支援瀏覽器宿主、Web
Worker、token 更新、連線期間重新驗證、撤銷清單、密碼、對稱 JWT、代理轉送的憑證標頭、關閉 TLS 驗證、程式碼散布、runner 容錯移轉或呼叫重放。
