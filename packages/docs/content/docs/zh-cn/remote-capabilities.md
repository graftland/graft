---
title: Remote 能力插件
description: 实现和测试传输、监听或认证能力。
---

能力就是带 default 导出的普通 Graft 插件，在 `apply`
中发布约定的服务键。Remote 通过应用的模块解析器读取
`{ name, config }`，在私有 assembly 里启动提供者；父 realm 的业务服务仍然可见。不需要自定义服务键，也不用在 remote
entry 旁边另装能力提供者。

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
元素也使用这样的引用，只是选择 Listener 和 Authenticator 插件。相对文件路径应基于 loader 的
`ConfigDirectory`。配置用插件的 Schema 解码；I/O 在激活时执行，不能在模块导入时执行。

## 四个契约

`@graftland/plugin-remote/Auth` 导出
`Credentials`、`Authenticator`；`/Transport` 导出
`Connector`、`Listener`。这些模块只有契约，不含 Node
listener 实现。下面只省略了服务键声明和导入限定名：

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

`read` 每次连接执行一次，返回声明的 kind；读取失败保存在
`CredentialsError.cause`。`authenticate`
返回稳定身份，不是会话 id。只有基于签发者的认证声明 `issuer`；bearer
token 文件没有签发者。一个 runner 不允许多个不同 issuer。第三方能力代码及其属性声明和其他插件一样，是受信任的。

`AuthenticationFailed` 有 `reason: "missing" | "invalid"`，以及可选的
`challenge` 和 `cause`。HTTP listener 在 upgrade 前映射为 401，把 challenge 写入
`WWW-Authenticate`。Bearer 缺失时为 `Bearer`，无效时为
`Bearer error="invalid_token"`。不要记录 Authorization 内容。传输失败用
`TransportError`，保留原始 cause。

## 属性与生命周期

- `protocol` 描述传输。`stdio` 独占；`stdio` 和 `command`
  不接受显式 auth；mTLS 要求 `wss`。
- `encrypted` 描述是否加密，mTLS 要求 true。
- `network`
  区分网络暴露和本地通道。不加密的网络传输在 runner 启动、宿主连接时 WARN；header 凭证会明确提示明文传输。网络 listener 用 none 时，启动和每次连接都 WARN。unix 不 WARN。
- `carries` 描述握手证据。header 认证要求 `header`，mTLS 要求
  `certificate`。它是声明，不是安全证明。

Remote 从认证器提取 TLS 策略，调用 `bind(tls)`，启动 `serve(accept)`，再等待
`ready`，同时与 serve 失败竞争。ready 表示接纳循环已注册，不只是端口绑定成功。runner 的所有必需 listener 就绪才算启动成功，运行期的失败只影响本 assembly。

Listener 必须在**接纳 HTTP upgrade 之前**调用
`accept(handshake)`。TLS 验证和客户端证书请求采用 bind 收到的策略，不能等 WebSocket 建立后再认证。成功后将通道交给返回的
`Session`，Remote 在内部把认证身份传给 supervisor。会话 fiber 与资源都要有 scope 归属。stdio 的 serve 在 EOF 时结束，网络 listener 持续监听直到中断。

Channel 是有序可靠字节流，chunk 边界没有含义；EOF 不是进程退出确认。WebSocket
adapter 必须拒绝文本、限制大小，每条二进制消息恰好承载一个完整帧，并重组拆开的输出 chunk。内置 adapter 已实现这些规则。

## 最小提供者

本地可信通道的认证器可以直接指定配置的身份。这个例子刻意不验证凭证，边界与 none 一样：

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

Connector 可以适配现有的作用域通道服务。下面把 I/O 交给应用的 `Link`，由
`Link.open` 在连接 scope 中管理资源：

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

它只支持 none：Remote 在调用前拒绝 header 和证书凭证。能力子树全部 Active 却不提供约定的键，会报能力契约错误；缺少业务服务仍是 Pending。

## 运行共享测试

导入
`@graftland/plugin-remote/Testing`，它不依赖测试框架。`transport(plugins, fixture)`
返回 `chunks` 和 `eof` 两个 Effect。plugins 包含
`connector`、`listener`、`credentials`、`authenticator`
插件定义。fixture 接收它们，在 Graft 中激活真实提供者和静态 inject 的消费者，返回连接到 echo 会话的 Channel。配置、地址和平台 Layer 由 fixture 提供，不必启动完整 runner。

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

chunks 会拆开帧头，再把余下部分和下一帧合并；eof 检查正常结束。`rejection(httpResponse, challenge?)`
检查 401、没有 upgrade、challenge 正确；失败表现为
`ConformanceError`。还应测试错误凭证、cause 保留、scope 取消、TLS 在 bind 前传入、ready 前 serve 失败，以及两个不同配置的 assembly 共存。[内置测试](https://github.com/graftland/graft/blob/main/packages/remote/test/capabilities.test.ts)展示了 websocket/mTLS 和其他内置组合的用法。

## 公开模块

包根导出宿主 default、`plugin`、`Contract`、`Instance`、公开错误及其类型。`/runner`
是 runner default。`/Auth`、`/Transport`、`/Errors`、`/Contract` 和 `/Testing`
是可复用 API。

`@graftland/plugin-remote/` 下的能力路径：

| 角色        | 路径                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| 宿主执行    | `host/local`、`host/worker`                                                     |
| 宿主连接    | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主凭证    | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner 监听 | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner 认证 | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

`/internal/bin`、`/internal/worker`、`/internal/watchdog`
只供运行时定位可执行文件，**不是公开 API**。Supervisor 和子进程运行时也在内部。应用请使用[remote 指南](../remote/)中的两个入口。
