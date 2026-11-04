---
title: 編寫自己的傳輸或驗證
description: 撰寫外掛，以內建選項以外的方式連線、監聽、提供憑證或驗證，並用共用檢查測試它。
---

本頁面向需要 Remote 未內建之連線或驗證方式的外掛作者，例如另一種網路協定，或來自公司身分服務的憑證。這裡先說明概念，再提供能執行的最小範例與測試方式。確切的簽名請見 API 參考中的
[`Transport`](../../reference/plugin-remote/transport/readme/) 與
[`Auth`](../../reference/plugin-remote/auth/readme/)。

## 概念

每個內建選項，例如 `url`、`unix`、`bearer` 或
`mtls`，都是某個普通 Graft 外掛的簡寫。Remote 把這些外掛稱為**能力**。每個能力恰好發布以下四種服務之一：

| 服務            | 所在側 | 職責                                                     | 模組                                 |
| --------------- | ------ | -------------------------------------------------------- | ------------------------------------ |
| `Connector`     | 宿主   | 開啟一條通往 runner 的位元組通道。                       | `@graftland/plugin-remote/Transport` |
| `Credentials`   | 宿主   | 讀取宿主要出示的內容：什麼都沒有、一個標頭值或一張憑證。 | `@graftland/plugin-remote/Auth`      |
| `Listener`      | runner | 接受來自宿主的位元組通道。                               | `@graftland/plugin-remote/Transport` |
| `Authenticator` | runner | 把宿主出示的內容轉換為身分。                             | `@graftland/plugin-remote/Auth`      |

這些模組只包含服務定義，不含 Node 實作。

要使用自己的能力，以它的模組名稱取代簡寫。在宿主上：

```yaml
connect:
  transport:
    name: my-remote-connector
    config: { address: example }
  auth:
    name: my-remote-credentials
    config: { account: billing }
```

在 runner 上，同樣的 `transport` 與 `auth` 寫在 `listen`
元素中，指向 listener 與 authenticator。名稱的解析方式與其他[外掛名稱](../../config-file/#外掛名稱)相同。

你不需要自己載入能力，也從不需要挑選服務鍵。Remote 會為引用某個能力的項目單獨啟動它。兩個項目可以用不同設定使用同一個能力而互不干擾，你的能力也仍然能注入應用程式的一般服務。

## 每個能力都要遵守的規則

- **預設匯出。** 模組以預設匯出的形式匯出外掛。
- **以 schema 解析設定。** 用外掛的 `config` schema 解碼 `config`。
- **啟用時才做 I/O。** 工作放在 `apply` 裡，絕不在匯入模組時進行。
- **相對路徑。** 像內建能力一樣，相對於 loader 的 `ConfigDirectory`
  解析設定中的檔案路徑，讓它們相對於設定檔。
- **發布服務。** 能力進入啟用狀態卻沒有發布服務，會以 `CapabilityContractError`
  失敗。等待缺少的應用程式服務的能力只會停留在 `Pending`。
- **保留 cause。** 傳輸失敗回報為 `TransportError`，憑證失敗回報為
  `CredentialsError`，原始失敗放在 `cause` 中。
- **絕不記錄機密。** 不要把 Authorization 的值寫進日誌。

能力程式碼和其他外掛一樣受到信任，包括它對自身的宣告。

## 描述傳輸

connector 與 listener 會宣告四個**屬性**。Remote 用它們拒絕不安全的組合，並決定記錄哪些警告：

| 屬性        | 意義                                                 | Remote 如何使用                                                                                      |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `protocol`  | 簡短的名稱，如 `wss` 或 `unix`。                     | mTLS 要求 `wss`。`stdio` 必須是 runner 唯一的 listener。`stdio` 與 `command` 拒絕任何明確的 `auth`。 |
| `encrypted` | 傳輸是否保障流量的機密性。                           | mTLS 要求為 `true`。未加密的網路傳輸會記錄警告。                                                     |
| `network`   | 是否可透過網路存取，而非僅限本機。                   | 未加密或未驗證的網路傳輸會記錄[選擇傳輸與驗證](../transport-auth/#警告的含義)中列出的警告。          |
| `carries`   | 交握能攜帶哪些憑據：`header`、`certificate` 或兩者。 | 以標頭為基礎的驗證（bearer、JWT）要求 `header`；mTLS 要求 `certificate`。                            |

這些是宣告，不是證明：Remote 照單全收。

**通道**雙向承載有序、可靠的位元組。區塊的邊界沒有意義，通道結束也不能證明外掛行程已經結束。

## listener 如何執行

Remote 依固定順序驅動 listener：

1. 從 authenticator 取得 TLS 政策（只有 mTLS 有），然後呼叫
   `bind`。TLS設定，包括要求用戶端憑證，都來自這份政策，而不是連線開啟後的某個步驟。
2. 以一個 `accept` 函式呼叫 `serve`，在等待 `ready` 的同時留意 `serve`
   是否失敗。`ready`
   表示接受迴圈已經在執行，而不只是位址已經綁定。runner 要等所有 listener 就緒才會啟動；之後失敗的 listener 只影響它自己。
3. 對每一條傳入連線，listener 在接受 HTTP upgrade **之前**，以宿主出示的內容呼叫
   `accept`。如果 `accept` 以 `AuthenticationFailed` 失敗，HTTP
   listener 回覆 401，並把錯誤的 `challenge` 作為 `WWW-Authenticate`
   送出。如果成功，listener 就用這條通道執行回傳的工作階段。經過驗證的身分由 Remote 自己附加。

每個工作階段的 fiber 及其資源都要歸屬於某個 scope。`stdio`
這類 listener 在輸入結束時完成
`serve`；網路 listener 會持續接受連線，直到被中斷。

`AuthenticationFailed` 的 `reason` 為 `"missing"` 或
`"invalid"`。內建的 bearer 與 JWT authenticator 使用的 challenge 分別是
`Bearer`（缺少）與
`Bearer error="invalid_token"`（無效）。authenticator 回傳的是穩定的身分，而不是工作階段 id。只有以簽發者為基礎的 authenticator 才宣告
`issuer`，runner 會拒絕簽發者不同的多個 listener。

WebSocket 轉接器還有額外的責任：拒絕文字訊息、限制訊框大小、每則二進位訊息恰好接受一個完整的協定訊框，並重新組合分成多塊的輸出。內建轉接器已經做到這些。

## 最小範例

一個用於受信任本機通道的 authenticator，可以直接給出一個設定好的身分。和 `none`
一樣，它什麼都不檢查：

```ts title="authenticator.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Authenticator } from "@graftland/plugin-remote/Auth"
import { Schema } from "effect"

export default Plugin.make({
	name: "fixed-local-identity",
	config: Schema.Struct({ identity: Schema.NonEmptyString }),
	apply: ({ identity }) =>
		Graft.provide(Authenticator, { _tag: "None", identity }),
})
```

connector 可以轉接應用程式既有的通道。這裡由應用程式服務 `Link`
開啟通道，它的資源歸屬於連線的 scope：

```ts title="connector.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Connector, type Channel } from "@graftland/plugin-remote/Transport"
import type { TransportError } from "@graftland/plugin-remote/Errors"
import { Context, Effect, type Scope } from "effect"

export class Link extends Context.Service<
	Link,
	{
		readonly open: Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("example/Link") {}

export default Plugin.make({
	name: "application-link",
	inject: [Link],
	apply: Effect.fnUntraced(function* () {
		const link = yield* Link
		yield* Graft.provide(Connector, {
			properties: {
				protocol: "application",
				encrypted: false,
				network: false,
				carries: [],
			},
			connect: () => link.open,
		})
	}),
})
```

由於 `carries` 是空的，這個 connector 只支援 `none`。Remote 在呼叫 `connect`
之前就會拒絕標頭與憑證類的憑據。

憑證在每次連線時讀取一次，並帶有宣告的種類：`None`、`Authorization`（標頭值）或
`Certificate`。

## 用共用檢查測試

`@graftland/plugin-remote/Testing`
包含內建能力都要通過的檢查。它不依賴任何測試框架，也不需要完整的 runner。

`Testing.transport(plugins, fixture)`
接收你的四個能力外掛（`connector`、`listener`、`credentials`、`authenticator`）與一個 fixture。fixture 在 Graft 中實際啟動它們以及一個消費者，並回傳一條連到 echo 工作階段的通道。設定、位址與平台 layer 都放在 fixture 裡。你會得到兩項檢查：

```ts
import * as Testing from "@graftland/plugin-remote/Testing"

const checks = Testing.transport(plugins, openEchoSession)

it.live("preserves bytes", () =>
	checks.chunks.pipe(Effect.scoped, Effect.provide(runtime)),
)
it.live("closes cleanly", () =>
	checks.eof.pipe(Effect.scoped, Effect.provide(runtime)),
)
```

- `chunks`
  把一個訊框標頭拆到兩塊中，再把剩餘部分與下一個訊框合成一塊，然後檢查位元組依序回傳。
- `eof` 檢查關閉通道會乾淨地結束它。
- `Testing.rejection(httpResponse, challenge?)`
  檢查被拒絕的憑證收到 401、沒有 WebSocket upgrade，並帶有預期的 challenge。

檢查失敗時以 `ConformanceError`
失敗。共用檢查涵蓋不到的也要測：錯誤的憑證、cause 是否保留、scope 取消、在
`bind` 時套用 TLS 設定、`serve` 在 `ready`
之前失敗，以及兩份設定不同的能力副本同時執行。[內建測試 fixture](https://github.com/graftland/graft/blob/main/packages/plugin-remote/test/capabilities.test.ts)
展示了 WebSocket 加 mTLS 以及其他所有內建組合的這些測試。

## 內建能力模組

簡寫會展開為 `@graftland/plugin-remote/` 下的這些模組。兩個執行模組支撐 `local`
與 `worker`，其餘都是一般的能力。

| 角色                 | 模組                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| 宿主執行             | `host/local`、`host/worker`                                                     |
| 宿主 connector       | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主 credentials     | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner listener      | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner authenticator | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

[參考](../reference/#已發布模組)列出所有已發布的模組。
