---
title: 撰寫能力外掛
description: 實作第三方傳輸或驗證外掛時看這一頁。
---

實作第三方傳輸或驗證外掛時看這一頁。以下介面與共用測試是 Connector、Listener、Credentials、Authenticator 的公開契約。

能力是帶有 default 匯出的一般 Graft 外掛，在 `apply`
發布約定的服務鍵。Remote 透過應用程式的模組解析器讀取
`{ name, config }`，在私有 assembly 啟動提供者；父 realm 的業務服務仍然可見。不必自訂服務鍵，也不用在 remote
entry 旁另外安裝能力提供者。

```yaml
connect:
  transport:
    name: my-remote-connector
    config: { address: example }
  auth:
    name: my-remote-credentials
    config: { account: billing }
```

runner 的 `listen`
元素也使用這種引用，只是選擇 Listener 與 Authenticator 外掛。相對檔案路徑應以 loader 的
`ConfigDirectory`
為準。設定由外掛的 Schema 解碼；I/O 在啟用時執行，不可在模組匯入時執行。

## 四個契約

`@graftland/plugin-remote/Auth` 匯出
`Credentials`、`Authenticator`；`/Transport` 匯出
`Connector`、`Listener`。這些模組只有契約，不含 Node
listener 實作。下列簽名只省略服務鍵宣告和匯入限定名稱：

```ts
interface ClientCertificate {
	cert: string
	key: Redacted<string>
}
interface VerifiedCertificate {
	der: Uint8Array
	subjectAltName: Option<string>
}
interface TlsPolicy {
	ca: ReadonlyArray<string>
	minVersion: "TLSv1.3"
	requestCert: true
	rejectUnauthorized: true
}
type Prepared =
	| { _tag: "None" }
	| { _tag: "Authorization"; value: Redacted<string> }
	| { _tag: "Certificate"; value: ClientCertificate }
type CredentialsApi = {
	[K in Prepared["_tag"]]: {
		kind: K
		read: Effect<Extract<Prepared, { _tag: K }>, CredentialsError, Scope>
	}
}[Prepared["_tag"]]
type AuthenticatorApi =
	| { _tag: "None"; identity: string }
	| {
			_tag: "Header"
			issuer?: string
			authenticate: (
				header: Option<Redacted<string>>,
			) => Effect<string, AuthenticationFailed>
	  }
	| {
			_tag: "Mtls"
			tls: TlsPolicy
			authenticate: (
				certificate: VerifiedCertificate,
			) => Effect<string, AuthenticationFailed>
	  }

interface Properties {
	protocol: string
	encrypted: boolean
	network: boolean
	carries: ReadonlyArray<"header" | "certificate">
}
interface Channel {
	input: Stream<Uint8Array, TransportError>
	output: Sink<unknown, Uint8Array, unknown, TransportError>
}
interface Handshake {
	authorization: Option<Redacted<string>>
	certificate: Option<VerifiedCertificate>
}
type Session = (channel: Channel) => Effect<void, TransportError, Scope>
type Accept = (handshake: Handshake) => Effect<Session, AuthenticationFailed>
interface Serving {
	ready: Effect<void>
	serve: (accept: Accept) => Effect<void, TransportError, Scope>
}
interface ConnectorApi {
	properties: Properties
	connect: (credentials: Prepared) => Effect<Channel, TransportError, Scope>
}
interface ListenerApi {
	properties: Properties
	bind: (tls: Option<TlsPolicy>) => Effect<Serving, TransportError, Scope>
}
```

`read` 每次連線執行一次，回傳宣告的 kind；讀取失敗保留在
`CredentialsError.cause`。`authenticate`
回傳穩定身分，不是工作階段 id。只有以簽發者為基礎的驗證宣告 `issuer`，bearer
token 檔案沒有簽發者。一個 runner 不允許多個不同 issuer。第三方能力程式碼與屬性宣告和其他外掛一樣，都是受信任的。

`AuthenticationFailed` 有 `reason: "missing" | "invalid"`，以及選填的
`challenge`、`cause`。HTTP listener 在 upgrade 前轉成 401，將 challenge 寫入
`WWW-Authenticate`。Bearer 缺少時是 `Bearer`，無效時是
`Bearer error="invalid_token"`。不要記錄 Authorization 內容。傳輸失敗用
`TransportError`，並保留原始 cause。

## 屬性與生命週期

- `protocol` 描述傳輸。`stdio` 獨占；`stdio` 和 `command`
  不接受明確指定的 auth；mTLS 要求 `wss`。
- `encrypted` 描述是否加密，mTLS 要求 true。
- `network`
  區分網路暴露與本機通道。未加密的網路傳輸在 runner 啟動、宿主連線時 WARN；header 憑證會明確提示明文傳輸。網路 listener 使用 none 時，啟動與每次連線都 WARN。unix 不 WARN。
- `carries` 描述握手證據。header 驗證要求 `header`，mTLS 要求
  `certificate`。這是宣告，不是安全證明。

Remote 從驗證器取得 TLS 策略，呼叫 `bind(tls)`，啟動 `serve(accept)`，再等
`ready`，同時與 serve 失敗競速。ready 表示接納迴圈已註冊，不只是連接埠綁定成功。runner 所有必要 listener 就緒才算啟動成功；執行期間的失敗只影響本 assembly。

Listener 必須在**接受 HTTP upgrade 之前**呼叫
`accept(handshake)`。TLS 驗證與客戶端憑證請求使用 bind 收到的策略，不可等 WebSocket 建立後才驗證。成功後將通道交給回傳的
`Session`，Remote 會在內部把驗證身分交給 supervisor。工作階段 fiber 與資源都必須有 scope 歸屬。stdio 的 serve 在 EOF 結束，網路 listener 則持續監聽直到中斷。

Channel 是有序可靠的位元組串流，chunk 邊界沒有意義；EOF 不是行程退出確認。WebSocket
adapter 必須拒絕文字、限制大小，每則二進位訊息恰好承載一個完整影格，並重組拆開的輸出 chunk。內建 adapter 已實作這些規則。

## 最小提供者

本機可信通道的驗證器可以直接指定設定的身分。這個範例刻意不驗證憑證，邊界與 none 相同：

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

Connector 可以適配既有的作用域通道服務。下例將 I/O 交給應用程式的 `Link`，由
`Link.open` 在連線 scope 管理資源：

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

它僅支援 none，Remote 會在呼叫前拒絕 header 與憑證驗證。能力子樹全數 Active 卻未提供約定的鍵，會回報能力契約錯誤；缺少業務服務仍是 Pending。

## 執行共享測試

匯入
`@graftland/plugin-remote/Testing`，它不依賴測試框架。`transport(plugins, fixture)`
回傳 `chunks` 與 `eof` 兩個 Effect。plugins 包含
`connector`、`listener`、`credentials`、`authenticator`
外掛定義。fixture 接收它們，在 Graft 啟用真實提供者與靜態 inject 的消費者，回傳連到 echo 工作階段的 Channel。設定、位址和平台 Layer 由 fixture 提供，不必啟動完整 runner。

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

chunks 會拆開影格標頭，再把餘下部分與下一個影格合併；eof 檢查正常結束。`rejection(httpResponse, challenge?)`
檢查 401、未 upgrade 與 challenge 正確；失敗是
`ConformanceError`。也應測試錯誤憑證、cause 保留、scope 取消、TLS 在 bind 前傳入、ready 前 serve 失敗，以及兩個不同設定的 assembly 共存。[內建測試](https://github.com/graftland/graft/blob/main/packages/remote/test/capabilities.test.ts)展示 websocket/mTLS 與其他內建組合的用法。

## 公開模組

套件根目錄匯出宿主 default、`plugin`、`Contract`、`Instance`、公開錯誤與型別。`/runner`
是 runner default。`/Auth`、`/Transport`、`/Errors`、`/Contract` 和 `/Testing`
是可重用 API。

`@graftland/plugin-remote/` 下的能力路徑：

| 角色        | 路徑                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| 宿主執行    | `host/local`、`host/worker`                                                     |
| 宿主連線    | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主憑證    | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner 監聽 | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner 驗證 | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

`/internal/bin`、`/internal/worker`、`/internal/watchdog`
僅供執行階段定位執行檔，**不是公開 API**。Supervisor 與子行程執行階段也在內部。應用程式請使用
[remote 指南](../overview/)中的兩個入口。
