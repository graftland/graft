---
title: 传输与认证
description: 选择宿主如何连到 runner，以及 runner 如何识别宿主。
---

一条 runner 连接由**传输**和**认证**组成：传输负责搬运字节，认证给宿主一个**身份**，例如
`billing`。直连的 `local` 和 `worker` 插件两者都没有。

## 组合

| 传输                           | 认证                            | 保护什么                                                                     | 警告                      |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------- | ------------------------- |
| `url: wss://…`                 | `mtls`、`bearer`、`jwt`、`none` | 加密；宿主校验 runner 的证书。                                               | 使用 `none` 时。          |
| `url: ws://…`                  | `bearer`、`jwt`、`none`         | 线路上毫无保护，路径上的任何人都能读取、篡改流量和 token。只用于回环和测试。 | 总会有；带 token 时更多。 |
| `unix: …`                      | `bearer`、`jwt`、`none`         | 能打开套接字文件的人就能连接。不读取对端的操作系统凭证。                     | 无。                      |
| `command: […]` / `stdio: true` | 不接受 `auth`，`none` 也不行    | 命令本身提供的保护，例如 SSH。                                               | 无。                      |

其他组合在连接之前就会失败：宿主上是 `CapabilityCombinationError`，runner 上是
`ListenerConfigError`。`ws` listener 不接受 `cert` 和 `key`，`wss`
listener 两者都需要。

## 认证选项

| 形式     | 宿主 `connect.auth`                | Runner `listen[].auth`                                                                                                                                                            | 身份                                                              |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `mtls`   | `{ cert, key }` 文件。仅限 `wss`。 | `{ ca }`：客户端证书必须链到的 CA。                                                                                                                                               | 证书中唯一的 `graft://` URI SAN：`graft://billing` 即 `billing`。 |
| `bearer` | `{ token }`                        | `{ tokens }`：JSON 文件 `{ "<token 的 sha256 十六进制>": "billing" }`。runner 从不保存 token 本身。                                                                               | 映射到的名字。                                                    |
| `jwt`    | `{ token }`                        | `issuer`、`audience`（列表）、`algorithms`（仅限非对称）、`keys`（`{ publicKey: file }` 或 `{ jwksUrl }`）、`identityClaim`（默认 `sub`）、`clockTolerance`（默认 `5 seconds`）。 | 身份 claim，必须是非空字符串。                                    |
| `none`   | `{}`，等同于不写 `auth`            | `{ identity }`，等同于不写 `auth`。什么都不检查。                                                                                                                                 | `identity`，默认 `anonymous`，所有调用方共用。                    |
| 自定义   | `{ name, config }`                 | `{ name, config }`                                                                                                                                                                | 见[能力插件](../capabilities/)。                                  |

- 宿主以 `Authorization: Bearer <token>`
  发送 token。bearer 摘要要按 token 的确切字节计算：`printf %s "$TOKEN" | shasum -a 256`。
- JWT 必须有 `exp`；`nbf` 存在时才检查。`clockTolerance` 可以为零。
- token 缺失或无效时，在 WebSocket 打开之前就会收到带 `WWW-Authenticate` 的 HTTP
  401。
- 客户端证书请用 Graft 专用的 CA：它签发的任何带 `graft://`
  名称的证书都能以该身份连接。客户端证书必须恰好有一个 `graft://`
  URI，可以另有其他 URI。服务器证书必须与宿主连接时用的名称一致。轮换证书时保持身份不变，宿主的实例也就保持不变。

`graft remote certificates` 签发一个私有 CA 和证书：

先在项目或用户级配置里启用命令插件：

```sh
graft add --plugin remote
```

```sh
graft remote certificates --out certs --server runner.example --identity billing
```

| 参数         | 默认值 | 含义                                                                 |
| ------------ | ------ | -------------------------------------------------------------------- |
| `--out`      | —      | 存放 CA 和证书的目录。                                               |
| `--server`   | —      | runner 的 DNS 名称或 IP，可重复。签发 `server.crt` 和 `server.key`。 |
| `--identity` | —      | 宿主身份，可重复。签发 `client-<identity>.crt` 和 `.key`。           |
| `--days`     | `365`  | 有效期。                                                             |
| `--force`    | 关     | 替换所请求的证书。不加时报 `CertificateExists`。                     |

第一次运行创建 `ca.crt` 和
`ca.key`，之后的运行复用它们；CA 从不被替换。身份在文件名中做 URI 编码，私钥以
`0600` 权限写入。`ca.key` 留在运维人员手里；`ca.crt` 分发给 runner 和各个宿主。

## 凭证来源

| 来源                    | 适用于             | 行为                                                                                                         |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| 值，`token: "..."`      | YAML 和 TypeScript | 原样使用。                                                                                                   |
| `token: { file: path }` | YAML 和 TypeScript | 每次连接都重新读取，因此可以轮换。整个文件就是 token，原样读取：末尾的换行符也会成为 token 的一部分。        |
| Effect                  | 仅 `Remote.plugin` | 每次连接运行一次。token 返回 `Redacted<string>`；`mtls` 返回 PEM 格式的 `{ cert, key }`，其中 `key` 已脱敏。 |
| `{ inject, read }`      | 仅 `Remote.plugin` | 需要服务的 Effect。其中某个服务被撤回时，远程插件停止，直到服务回来。                                        |

证书、私钥和 CA 始终是文件路径，相对于配置文件。

```ts
import { Config } from "effect"

import type * as Remote from "@graftland/plugin-remote"

export const connect: Remote.Connect = {
	url: "wss://runner.example:7443",
	instance: "greeter",
	auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
}
```

## 警告

| 消息                                                                        | 何时出现                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ws:// listener is unencrypted`                                             | runner 启动时，针对 `ws` listener。                    |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext`   | 同上，且使用 bearer 或 JWT。                           |
| `ws:// connection is unencrypted`                                           | 宿主，每条 `ws` 连接。                                 |
| `ws:// connection is unencrypted; credentials are transmitted in plaintext` | 同上，且宿主发送了 token。                             |
| `WebSocket listener has no authentication`                                  | runner 启动时，针对使用 `none` 的网络 listener。       |
| `WebSocket connection has no authentication`                                | runner，经由这类 listener 的每条连接。                 |
| `Remote host authentication failed`                                         | runner 拒绝宿主凭证时，附带 `reason`。                 |
| `Remote host connection failed`                                             | runner，连接异常结束时，附带身份。                     |
| `Remote listener failed`                                                    | runner，某个 listener 在启动后失败时。                 |
| `Superseded remote execution cleanup failed`                                | runner，清理被替换的插件进程失败时。                   |
| `Remote logs were dropped`                                                  | 宿主，转发来的插件日志在高负载下丢失时，附带丢失数量。 |

Unix 套接字、命令和 `stdio` 从不记录传输类警告。要消除这些警告，请改用带认证的
`wss`。

## 信任与局限

- Remote 信任 runner 的安装目录和配置、它的操作系统和本地权限、专用 CA，以及配置的 JWT 签发方和密钥。
- token 和 JWT 只在连接打开时检查一次。之后才过期的 JWT 不会结束已经打开的会话。
- 被盗的 token 在过期之前都有效。只通过 `wss`
  发送 token，并让 JWT 的有效期保持短暂。
- `none` 只是一个名字，不是一次检查。
- 不支持：浏览器宿主、Web
  Worker、token 刷新、会话期间重新认证、吊销列表、密码、对称 JWT 算法、代理转发的证书头、关闭 TLS 校验、向 runner 分发代码、runner 故障转移，以及重放调用。
