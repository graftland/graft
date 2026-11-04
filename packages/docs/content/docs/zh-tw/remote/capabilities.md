---
title: 能力外掛
description: 撰寫自己的 connector、listener、credentials 或 authenticator。
---

每種傳輸與驗證形式都是某個**能力**的簡寫：能力是發布四種服務之一的普通 Graft 外掛。在原本寫簡寫的位置填入自己的能力即可。簽名請見 API 參考中的
[`Transport`](../../reference/plugin-remote/transport/readme/)、
[`Auth`](../../reference/plugin-remote/auth/readme/) 與
[套件本身](../../reference/plugin-remote/readme/)。

```yaml
connect:
  transport: { name: my-remote-connector, config: { address: example } }
  auth: { name: my-remote-credentials, config: { account: billing } }
```

| 服務            | 所在側 | 職責                                                                           | 匯入自（只含定義）                   |
| --------------- | ------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| `Connector`     | 宿主   | 開啟一條通往 runner 的位元組通道。                                             | `@graftland/plugin-remote/Transport` |
| `Credentials`   | 宿主   | 讀取宿主要出示的內容：`None`、`Authorization` 或 `Certificate`，每次連線一次。 | `@graftland/plugin-remote/Auth`      |
| `Listener`      | runner | 接受來自宿主的位元組通道。                                                     | `@graftland/plugin-remote/Transport` |
| `Authenticator` | runner | 把宿主出示的內容轉換為穩定的身分，而不是工作階段 id。                          | `@graftland/plugin-remote/Auth`      |

在 runner 上，`transport` 與 `auth` 寫在 `listen`
元素中。名稱的解析方式與其他[外掛名稱](../../config-file/#外掛名稱)相同。Remote會為每個設定項目各啟動一份私有副本，所以不同設定項目可以用不同設定使用同一個能力，能力也仍然能注入應用程式的服務。

| 規則      | 說明                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| **匯出**  | 外掛是模組的預設匯出。                                                                    |
| **設定**  | 用外掛的 `config` schema 解碼。路徑相對於 loader 的 `ConfigDirectory` 解析。              |
| **I/O**   | 只在 `apply` 中進行，絕不在匯入時進行。                                                   |
| **發布**  | 啟用後沒有發布服務會以 `CapabilityContractError` 失敗。等待某個服務時則停留在 `Pending`。 |
| **cause** | 回報 `TransportError` 或 `CredentialsError`，並把原始失敗放在 `cause`。                   |
| **機密**  | 絕不記錄 Authorization 的值。                                                             |
| **信任**  | 能力的程式碼及它對自己的宣告，都像任何外掛一樣受到信任。                                  |

## 屬性

connector 與 listener 會宣告屬性。Remote 相信這些宣告，用它們拒絕不合的組合並決定要記錄哪些[警告](../transport-auth/#警告)。

| 屬性        | 意義                                        | Remote 的要求                                                                              |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `protocol`  | 簡短名稱，例如 `wss` 或 `unix`。            | mTLS 需要 `wss`。`stdio` 必須是唯一的 listener。`stdio` 與 `command` 不接受明確的 `auth`。 |
| `encrypted` | 流量是否保密。                              | mTLS 需要 `true`。未加密的網路傳輸會發出警告。                                             |
| `network`   | 是否透過網路連線，而不是只在本機。          | 未加密或未驗證的網路傳輸會發出警告。                                                       |
| `carries`   | 交握能攜帶的憑據：`header`、`certificate`。 | bearer 與 JWT 需要 `header`，mTLS 需要 `certificate`。為空時只允許 `none`。                |

**通道**雙向承載有序、可靠的位元組。分塊邊界沒有意義，通道結束也不能證明外掛行程已退出。

## listener 如何執行

1. **繫結**：使用 authenticator 提供的 TLS 政策（只有 mTLS 有）。TLS 設定，包括要求用戶端憑證，都來自這個政策。
2. **服務**：帶著 `accept` 函式呼叫 `graft start`。Remote 等待
   `ready`（表示接受迴圈已在執行），同時監看 `graft start`
   是否失敗。所有 listener 都就緒後 runner 才啟動；之後的失敗只影響那個 listener。
3. **接受**：每條連線在任何 HTTP 升級之前，以宿主出示的內容呼叫 `accept`。遇到
   `AuthenticationFailed` 時，HTTP listener 回應 401，並把錯誤的 `challenge`
   放進 `WWW-Authenticate`。
4. **執行**：用通道執行回傳的工作階段。身分由 Remote 附上。

- 每個工作階段的 fiber 與資源都歸屬於某個 scope。
- `stdio` 類的 listener 在輸入結束時結束
  `graft start`；網路 listener 則持續接受連線，直到被中斷。
- `AuthenticationFailed.reason` 為 `"missing"` 或
  `"invalid"`。內建的 bearer 與 JWT 使用的 challenge 為 `Bearer` 與
  `Bearer error="invalid_token"`。
- 只有以 issuer 為基礎的 authenticator 會宣告
  `issuer`；runner 會拒絕 issuer 不同的 listener。
- WebSocket 轉接層要拒絕文字訊息、強制執行訊框大小上限、每則二進位訊息只接受一個完整的協定訊框，並重組分成多塊送出的輸出。

## 範例

一個給受信任本機通道使用的 authenticator，只發放一個身分，並且和 `none`
一樣不檢查任何東西：

```ts title="authenticator.ts"
export default Plugin.make({
	name: "fixed-local-identity",
	config: Schema.Struct({ identity: Schema.NonEmptyString }),
	apply: ({ identity }) =>
		Graft.provide(Authenticator, { _tag: "None", identity }),
})
```

## 一致性檢查

`@graftland/plugin-remote/Testing` 收錄內建能力通過的檢查，不需要任何測試框架。

```ts
const checks = Testing.transport(plugins, openEchoSession)

it.live("preserves bytes", () =>
	checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
)
```

| 檢查                                          | 驗證內容                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Testing.transport(plugins, fixture)`         | 接收 `connector`、`listener`、`credentials` 與 `authenticator`；fixture 在 Graft 中連同一個使用者實際啟動它們，並回傳一條連到 echo 工作階段的通道。 |
| `chunks`                                      | 訊框標頭被拆開、訊框被合併時，位元組仍依序抵達。                                                                                                    |
| `eof`                                         | 關閉通道會乾淨地結束它。                                                                                                                            |
| `Testing.rejection(httpResponse, challenge?)` | 被拒絕的憑證收到 401、沒有升級，且帶有預期的 challenge。                                                                                            |

失敗時拋出
`ConformanceError`。另外也要測試錯誤的憑證、cause 是否保留、scope 取消、在
`bind` 時套用 TLS、`graft start` 在 `ready`
之前失敗，以及兩份設定不同的副本同時執行，做法可參考
[內建測試 fixture](https://github.com/graftland/graft/blob/main/packages/plugin-remote/test/capabilities.test.ts)。

## 內建模組

| 角色                 | `@graftland/plugin-remote/` 下的模組                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| 宿主執行方式         | `host/local`、`host/worker`                                                     |
| 宿主 connector       | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主 credentials     | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner listener      | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner authenticator | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

`/internal/child`、`/internal/worker` 與 `/internal/watchdog`
供 Remote 啟動自己的執行環境，不是公開 API。
