---
title: 能力插件
description: 编写自己的 connector、listener、凭证或 authenticator。
---

每种传输和认证形式都是某个**能力**的简写：能力是发布四种服务之一的普通 Graft 插件。在写简写的位置填上你自己的能力即可。签名见 API 参考中的
[`Transport`](../../reference/plugin-remote/transport/readme/)、[`Auth`](../../reference/plugin-remote/auth/readme/)
和[整个包](../../reference/plugin-remote/readme/)。

```yaml
connect:
  transport: { name: my-remote-connector, config: { address: example } }
  auth: { name: my-remote-credentials, config: { account: billing } }
```

| 服务            | 所在侧 | 职责                                                                           | 导入自（只含定义）                   |
| --------------- | ------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| `Connector`     | 宿主   | 打开一条通往 runner 的字节通道。                                               | `@graftland/plugin-remote/Transport` |
| `Credentials`   | 宿主   | 读取宿主要出示的内容：`None`、`Authorization` 或 `Certificate`，每次连接一次。 | `@graftland/plugin-remote/Auth`      |
| `Listener`      | runner | 接受来自宿主的字节通道。                                                       | `@graftland/plugin-remote/Transport` |
| `Authenticator` | runner | 把宿主出示的内容转换为稳定的身份，而不是会话 id。                              | `@graftland/plugin-remote/Auth`      |

在 runner 上，`transport` 和 `auth` 写在 `listen`
元素中。名字的解析方式与其他[插件名称](../../config-file/#插件名称)相同。Remote 为每个条目单独启动一份能力，因此不同条目可以用不同配置使用同一个能力，能力也仍然可以注入应用的服务。

| 规则      | 说明                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| **导出**  | 插件是模块的默认导出。                                                                    |
| **配置**  | 用插件的 `config` schema 解码。路径相对于 loader 的 `ConfigDirectory` 解析。              |
| **I/O**   | 只在 `apply` 中进行，绝不在导入时进行。                                                   |
| **发布**  | 激活后没有发布服务，会以 `CapabilityContractError` 失败。等待某个服务时停留在 `Pending`。 |
| **Cause** | 以 `TransportError` 或 `CredentialsError` 报告失败，原始失败放在 `cause` 中。             |
| **密钥**  | 绝不把 Authorization 的值写进日志。                                                       |
| **信任**  | 能力代码及其对自身的声明，与其他插件一样被信任。                                          |

## 属性

connector 和 listener 声明一组属性。Remote 照单全收，用它们拒绝组合并决定记录哪些[警告](../transport-auth/#警告)。

| 属性        | 含义                                      | Remote 的要求                                                                            |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `protocol`  | 简短的名字，如 `wss` 或 `unix`。          | mTLS 要求 `wss`。`stdio` 必须是唯一的 listener。`stdio` 和 `command` 不接受显式 `auth`。 |
| `encrypted` | 流量是否保密。                            | mTLS 要求为 `true`。不加密的网络传输会记录警告。                                         |
| `network`   | 是否通过网络可达，而非仅限本地。          | 网络传输在不加密或无认证时记录警告。                                                     |
| `carries`   | 握手携带的凭据：`header`、`certificate`。 | bearer 和 JWT 要求 `header`，mTLS 要求 `certificate`。为空时只允许 `none`。              |

**通道**双向承载有序、可靠的字节。块的边界没有意义，通道结束也不能证明插件进程已经退出。

## listener 如何运行

1. **绑定**，使用 authenticator 给出的 TLS 策略；只有 mTLS 有这样的策略。TLS 设置（包括请求客户端证书）都来自这个策略。
2. **服务**，调用 `serve(accept)`。Remote 等待
   `ready`（表示 accept 循环已经在运行），同时监视 `serve`
   是否失败。所有 listener 都就绪后 runner 才算启动；之后的失败只影响那一个 listener。
3. **接受**每条连接：在任何 HTTP 升级之前，用宿主出示的内容调用 `accept`。遇到
   `AuthenticationFailed` 时，HTTP listener 返回 401，并把错误的 `challenge`
   作为 `WWW-Authenticate`。
4. **运行**返回的会话，交给它这条通道。身份由 Remote 附加。

- 每个会话的 fiber 和资源都要归属于某个 scope。
- `stdio` 式的 listener 在输入结束时结束
  `graft start`；网络 listener 会一直接受连接，直到被中断。
- `AuthenticationFailed.reason` 是 `"missing"` 或
  `"invalid"`。内置的 bearer 和 JWT 使用的 challenge 分别是 `Bearer` 和
  `Bearer error="invalid_token"`。
- 只有基于签发方的 authenticator 才声明
  `issuer`；runner 会拒绝签发方不同的多个 listener。
- WebSocket 适配器要拒绝文本消息、执行帧大小限制、每条二进制消息只接受一个完整的协议帧，并重新拼接分块输出。

## 示例

一个用于可信本地通道的 authenticator，只发放一个身份，和 `none`
一样什么都不检查：

```ts import.meta.vitest name="remote/capabilities: a fixed identity"
import { Deferred, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import {
	Authenticator,
	type AuthenticatorApi,
} from "@graftland/plugin-remote/Auth"

const fixedLocalIdentity = Plugin.make({
	name: "app/fixed-local-identity",
	config: Schema.Struct({ identity: Schema.NonEmptyString }),
	apply: ({ identity }) =>
		Graft.provide(Authenticator, { _tag: "None", identity }),
})
export default fixedLocalIdentity

const published = await Effect.runPromise(
	Effect.gen(function* () {
		const found = yield* Deferred.make<AuthenticatorApi>()
		yield* Graft.plugin(fixedLocalIdentity, { identity: "local" })
		yield* Graft.plugin(
			Plugin.make({
				name: "app/reader",
				inject: [Authenticator],
				apply: () =>
					Effect.gen(function* () {
						const authenticator = yield* Authenticator
						yield* Deferred.succeed(found, authenticator)
					}),
			}),
		)
		return yield* Deferred.await(found)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
published // => { _tag: "None", identity: "local" }
```

## 一致性检查

`@graftland/plugin-remote/Testing` 包含内置能力通过的检查，不依赖任何测试框架。

```ts
import type { Effect, Scope } from "effect"
import { layer } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import * as Testing from "@graftland/plugin-remote/Testing"
import type { Channel } from "@graftland/plugin-remote/Transport"

declare const plugins: Testing.Capabilities
declare const openEchoSession: (
	plugins: Testing.Capabilities,
) => Effect.Effect<Channel, never, Graft.Graft | Scope.Scope>

const checks = Testing.transport(plugins, openEchoSession)

layer(Graft.layer, { excludeTestServices: true })((it) => {
	it.effect("preserves bytes", () => checks.chunks)
})
```

| 检查                                          | 验证内容                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Testing.transport(plugins, fixture)`         | 接收 `connector`、`listener`、`credentials` 和 `authenticator`；fixture 在 Graft 中连同一个使用方真实启动它们，并返回一条连到回显会话的通道。 |
| `chunks`                                      | 帧头被拆开、多个帧被合并时，字节仍按顺序到达。                                                                                                |
| `eof`                                         | 关闭通道能干净地结束它。                                                                                                                      |
| `Testing.rejection(httpResponse, challenge?)` | 被拒绝的凭证得到 401、没有升级，并带有预期的 challenge。                                                                                      |

失败时报
`ConformanceError`。另外还要测试错误的凭证、cause 是否保留、scope 取消、在
`bind` 时应用 TLS、`serve` 在 `ready`
之前失败，以及两份配置不同的副本同时运行，可参考[内置的测试 fixture](https://github.com/graftland/graft/blob/main/packages/plugin-remote/test/capabilities.test.ts)。

## 内置模块

| 角色                 | `@graftland/plugin-remote/` 下的模块                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| 宿主执行             | `host/local`、`host/worker`                                                     |
| 宿主 connector       | `host/websocket`、`host/unix`、`host/command`                                   |
| 宿主凭证             | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         |
| runner listener      | `runner/websocket`、`runner/unix`、`runner/stdio`                               |
| runner authenticator | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` |

`/internal/child`、`/internal/worker` 和 `/internal/watchdog`
供 Remote 启动自己的运行时，不是公开 API。
