---
title: 编写自己的传输或认证
description: 编写插件，以内置选项之外的方式连接、监听、提供凭证或认证，并用共享检查测试它。
---

本页面向需要 Remote 未内置的连接或认证方式的插件作者，例如另一种网络协议，或来自公司身份服务的凭证。这里先讲思路，再给出能运行的最小示例和测试方法。确切的签名见 API 参考中的
[`Transport`](../../reference/plugin-remote/transport/readme/) 和
[`Auth`](../../reference/plugin-remote/auth/readme/)。

## 思路

每个内置选项，比如 `url`、`unix`、`bearer` 或
`mtls`，都是某个普通 Graft 插件的简写。Remote 把这些插件称为**能力**。每个能力恰好发布以下四种服务之一：

| 服务            | 所在侧 | 职责                                                     | 模块                                 |
| --------------- | ------ | -------------------------------------------------------- | ------------------------------------ |
| `Connector`     | 宿主   | 打开一条通往 runner 的字节通道。                         | `@graftland/plugin-remote/Transport` |
| `Credentials`   | 宿主   | 读取宿主要出示的内容：什么都没有、一个头部值或一张证书。 | `@graftland/plugin-remote/Auth`      |
| `Listener`      | runner | 接受来自宿主的字节通道。                                 | `@graftland/plugin-remote/Transport` |
| `Authenticator` | runner | 把宿主出示的内容转换为身份。                             | `@graftland/plugin-remote/Auth`      |

这些模块只包含服务定义，不含 Node 实现。

要使用自己的能力，用它的模块名代替简写。在宿主上：

```yaml
connect:
  transport:
    name: my-remote-connector
    config: { address: example }
  auth:
    name: my-remote-credentials
    config: { account: billing }
```

在 runner 上，同样的 `transport` 与 `auth` 写在 `listen`
元素中，指向 listener 和 authenticator。名字的解析方式与其他[插件名称](../../config-file/#插件名称)相同。

你不需要自己加载能力，也从不需要挑选服务键。Remote 会为引用某个能力的条目单独启动它。两个条目可以用不同配置使用同一个能力而互不干扰，你的能力也仍然可以注入应用的普通服务。

## 每个能力都要遵守的规则

- **默认导出。** 模块以默认导出的形式导出插件。
- **用 schema 解析配置。** 用插件的 `config` schema 解码 `config`。
- **激活时做 I/O。** 工作放在 `apply` 里，绝不在导入模块时进行。
- **相对路径。** 像内置能力一样，相对于 loader 的 `ConfigDirectory`
  解析配置中的文件路径，让它们相对于配置文件。
- **发布服务。** 能力进入激活状态却没有发布服务，会以 `CapabilityContractError`
  失败。等待缺失的应用服务的能力只会停留在 `Pending`。
- **保留 cause。** 传输失败报告为 `TransportError`，凭证失败报告为
  `CredentialsError`，原始失败放在 `cause` 中。
- **绝不记录密钥。** 不要把 Authorization 的值写进日志。

能力代码和其他插件一样被信任，包括它对自身的声明。

## 描述传输

connector 和 listener 声明四个**属性**。Remote 用它们拒绝不安全的组合，并决定记录哪些警告：

| 属性        | 含义                                                 | Remote 如何使用                                                                                    |
| ----------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `protocol`  | 一个简短的名字，如 `wss` 或 `unix`。                 | mTLS 要求 `wss`。`stdio` 必须是 runner 唯一的 listener。`stdio` 和 `command` 拒绝任何显式 `auth`。 |
| `encrypted` | 传输是否保证流量机密。                               | mTLS 要求为 `true`。不加密的网络传输会记录警告。                                                   |
| `network`   | 是否通过网络可达，而非仅限本地。                     | 不加密或无认证的网络传输会记录[选择传输与认证](../transport-auth/#警告的含义)中列出的警告。        |
| `carries`   | 握手能携带哪些凭据：`header`、`certificate` 或两者。 | 基于头部的认证（bearer、JWT）要求 `header`；mTLS 要求 `certificate`。                              |

这些是声明，不是证明：Remote 照单全收。

**通道**双向承载有序、可靠的字节。块的边界没有意义，通道结束也不能证明插件进程已经退出。

## listener 如何运行

Remote 按固定顺序驱动 listener：

1. 从 authenticator 取得 TLS 策略（只有 mTLS 有），然后调用
   `bind`。TLS设置，包括请求客户端证书，都来自这份策略，而不是连接打开后的某个步骤。
2. 用一个 `accept` 函数调用 `serve`，在等待 `ready` 的同时留意 `serve`
   是否失败。`ready`
   表示接受循环已经在运行，而不仅仅是地址已经绑定。runner 要等所有 listener 都就绪才会启动；之后失败的 listener 只影响它自己。
3. 对每个传入连接，listener 在接受 HTTP upgrade **之前**，用宿主出示的内容调用
   `accept`。如果 `accept` 以 `AuthenticationFailed` 失败，HTTP
   listener 回复 401，并把错误的 `challenge` 作为 `WWW-Authenticate`
   发送。如果成功，listener 用这条通道运行返回的会话。经过认证的身份由 Remote 自己附加。

每个会话 fiber 及其资源都要归属于某个 scope。`stdio`
这类 listener 在输入结束时完成
`serve`；网络 listener 会一直接受连接，直到被中断。

`AuthenticationFailed` 的 `reason` 为 `"missing"` 或
`"invalid"`。内置的 bearer 和 JWT authenticator 使用的 challenge 分别是
`Bearer`（缺失）和
`Bearer error="invalid_token"`（无效）。authenticator 返回的是稳定的身份，而不是会话 id。只有基于签发方的 authenticator 才声明
`issuer`，runner 会拒绝签发方不同的多个 listener。

WebSocket 适配器还有额外的责任：拒绝文本消息、限制帧大小、每条二进制消息恰好接受一个完整的协议帧，并重新拼接分成多块的输出。内置适配器已经做到这些。

## 最小示例

一个用于受信任本地通道的 authenticator，可以直接给出一个配置好的身份。和 `none`
一样，它什么都不检查：

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

connector 可以适配应用已有的通道。这里由应用服务 `Link`
打开通道，它的资源归属于连接的 scope：

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

由于 `carries` 为空，这个 connector 只支持 `none`。Remote 在调用 `connect`
之前就会拒绝头部和证书凭证。

凭证在每次连接时读取一次，并带有声明的种类：`None`、`Authorization`（头部值）或
`Certificate`。

## 用共享检查测试

`@graftland/plugin-remote/Testing`
包含内置能力都要通过的检查。它不依赖任何测试框架，也不需要完整的 runner。

`Testing.transport(plugins, fixture)`
接收你的四个能力插件（`connector`、`listener`、`credentials`、`authenticator`）和一个 fixture。fixture 在 Graft 中真实启动它们以及一个消费者，并返回一条连到 echo 会话的通道。配置、地址和平台 layer 都放在 fixture 里。你会得到两项检查：

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
  把一个帧头拆到两块中，再把剩余部分与下一帧合在一块，然后检查字节按顺序返回。
- `eof` 检查关闭通道会干净地结束它。
- `Testing.rejection(httpResponse, challenge?)`
  检查被拒绝的凭证收到 401、没有 WebSocket upgrade，并带有预期的 challenge。

检查失败时以 `ConformanceError`
失败。共享检查覆盖不到的也要测：错误的凭证、cause 是否保留、scope 取消、在
`bind` 时应用 TLS 设置、`serve` 在 `ready`
之前失败，以及两份配置不同的能力副本同时运行。[内置测试 fixture](https://github.com/graftland/graft/blob/main/packages/remote/test/capabilities.test.ts)
展示了 WebSocket 加 mTLS 以及其他所有内置组合的这些测试。

## 内置能力模块

简写会展开为 `@graftland/plugin-remote/` 下的这些模块。两个执行模块支撑 `local`
和 `worker`，其余都是普通的能力。

| 角色                 | 模块                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| 宿主执行             | `host/local`、`host/worker`                                                     |
| 宿主 connector       | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主 credentials     | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner listener      | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner authenticator | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

[参考](../reference/#已发布模块)列出了所有已发布的模块。
