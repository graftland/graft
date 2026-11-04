---
title: 选择传输与认证
description: 宿主和 runner 如何连接，每种方式能防住什么，以及各种警告的含义。
---

本页帮助你决定宿主如何连接 runner，以及 runner 如何知道宿主是谁。这里说明每种选项能防住什么、防不住什么，以及日志里的警告是什么意思。直连的
`local` 和 `worker` 插件不涉及这些：它们既没有网络连接，也不需要认证。

## 简短的答案

| 场景                         | 选用                                      |
| ---------------------------- | ----------------------------------------- |
| 宿主通过网络访问 runner      | `wss` 配合 JWT、mTLS 或 bearer token      |
| 已经用 SSH 管理访问权限      | `command: [ssh, ...]` 配合 `stdio` runner |
| 宿主和 runner 在同一台机器上 | Unix 套接字，用文件权限把关               |
| 在 `127.0.0.1` 上试用        | `ws` 配合 `none`，会看到警告              |

一条连接由两个独立的选择组成：

- **传输**负责搬运字节：WebSocket、Unix 套接字，或某个命令的标准输入输出。
- **认证**告诉 runner 宿主是谁，结果是一个**身份**，即 `billing`
  这样的名字。身份与实例名一起决定一个连接属于哪个正在运行的插件，所以身份和实例名都相同的两个宿主会互相替换对方的插件。

## 传输

**`wss://`**
是基于 TLS 的 WebSocket。流量是加密的，宿主会校验 runner 的证书：设置了 `ca`
就用它校验，否则用 Node 信任的 CA。当需要校验的名称与 URL 的主机名不同时，用
`servername` 覆盖。只要流量经过网络，就应该用它。

**`ws://`**
是不加密的 WebSocket。路径上的任何人都能读取、篡改流量，包括宿主发送的 token。只在回环地址或测试中使用。

**`unix:`**
是同一台机器上的 Unix 套接字。能打开套接字文件的人就能连接，所以文件权限就是访问控制。runner 不读取对端的操作系统凭证。

宿主上的 **`command:`** 与 runner 上的 **`stdio: true`**
通过某个命令（通常是 SSH）的标准输入输出运行协议。认证和加密都由该命令提供，所以这两种形式完全不接受
`auth`，`none` 也不行。

WebSocket listener 只服务一个路径 `/graft`，子协议为
`graft-remote.v1`。没有其他 HTTP 端点，也没有健康检查。

## 认证

**mTLS**（双向 TLS）：宿主出示由 runner 信任的 CA 签发的客户端证书，身份取自证书中的
`graft://` 名称，`graft://billing` 即 `billing`。只能用于 `wss`。

**Bearer
token**：宿主发送一个共享密钥。runner 从不保存 token 本身，只在一个文件里保存它的 SHA-256 摘要到身份的映射。

**JWT**：宿主发送由你运营或使用的签发方签名的 token。runner 用签发方的公钥或 JWKS 校验签名，并检查签发方、受众和过期时间，再从某个 claim（默认
`sub`）中取出身份。

**None**：什么都不检查。在 runner 上，`none` 给所有调用方同一个身份，没有设置
`identity` 时为 `anonymous`。不写 `auth` 就等于 `none`。

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

摘要要基于 token 的确切字节计算，例如
`printf %s "$TOKEN" | shasum -a 256`。`{ file }`
形式的 token 会原样读取，包括末尾的换行符，所以 token 文件不要以换行结尾。

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

如果要从签发方获取公钥而不是读文件，用
`keys: { jwksUrl: https://issuer.example/jwks }`。token 必须带 `exp` claim；有
`nbf` 时也会检查；身份 claim 必须是非空字符串。`clockTolerance`（默认
`5 seconds`）用于容忍时钟偏差。只接受非对称算法。

### mTLS

`graft-remote certificates` 可以一次签发专用 CA、服务器证书和客户端证书：

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

| 文件                                       | 放到哪里              |
| ------------------------------------------ | --------------------- |
| `ca.key`                                   | 由管理员保管          |
| `ca.crt`                                   | runner 和各个宿主     |
| `server.crt`、`server.key`                 | runner                |
| `client-billing.crt`、`client-billing.key` | 名为 `billing` 的宿主 |

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

也可以用其他工具，规则是：服务器证书必须与宿主连接时使用的主机名相符；客户端证书的主题备用名称中必须恰好有一个
`graft://`
URI（可以同时存在其他 URI）。客户端证书请使用 Graft 专用的 CA：它签发的任何带
`graft://`
名称的证书，都能以该身份连接。轮换证书时保持身份不变，宿主就能保留它的实例。

## 所有组合

| 传输                           | 认证                    | 效果                                             | 警告                                                                          |
| ------------------------------ | ----------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `local: {}`                    | 不可写                  | 独立进程，拥有普通的操作系统权限。               | 无。                                                                          |
| `worker: {}`                   | 不可写                  | 宿主进程中的独立线程。隔离执行，**不隔离权限**。 | 无。                                                                          |
| `url: wss://…`                 | mtls、bearer、jwt、none | 加密，并校验 runner 的证书。                     | 使用 `none` 时：runner 启动时和每次连接时。                                   |
| `url: ws://…`                  | bearer、jwt、none       | 不加密。                                         | runner 启动时、宿主连接时；带 token 时措辞更严重。`none` 另有每次连接的警告。 |
| `unix: …`                      | bearer、jwt、none       | 由文件权限控制访问。                             | 无。                                                                          |
| `command: […]` / `stdio: true` | 不可写，`none` 也不行   | 取决于命令本身，例如 SSH。                       | 无。                                                                          |

表格以外的组合在连接前就会失败。mTLS 需要 `wss`；`ws` listener 不接受 `cert` 或
`key`，`wss` listener 两者都必须提供。

## 警告的含义

| 警告                                                                      | 由谁记录           | 含义                                                          |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `ws:// listener is unencrypted`                                           | runner，启动时     | 网络 listener 没有 TLS。                                      |
| `ws:// listener is unencrypted; credentials are transmitted in plaintext` | runner，启动时     | 同上，而且它的 token 可以在线路上被读取。                     |
| `ws:// connection is unencrypted`（以及带 credentials 的版本）            | 宿主，每次连接时   | 同一问题在宿主一侧的表现。                                    |
| `WebSocket listener has no authentication`                                | runner，启动时     | 网络 listener 使用 `none`：任何能访问它的人都会得到它的身份。 |
| `WebSocket connection has no authentication`                              | runner，每次连接时 | 有宿主通过这样的 listener 连接进来。                          |

Unix 套接字、命令和 `stdio` 从不产生这些警告。解决办法总是一样：换成
`wss`，并加上认证。

## 认证做不到的事

- **只检查一次。** bearer
  token 和 JWT 在连接建立时检查。缺失或无效的 token 会在 WebSocket 打开之前收到 HTTP
  401 和 `WWW-Authenticate` 头。之后才过期的 JWT 不会结束已经建立的会话。
- **token 可以被重放。** 偷到 token 的人可以在其有效期内使用它。只通过 `wss`
  发送 token，并让 JWT 的有效期尽量短。
- **`none` 只是一个名字，不是检查。** 所有调用方共用它的身份。

## Remote 信任什么

Remote 信任 runner 的安装、配置、操作系统与本地权限、专用 CA，以及配置的 JWT 签发方和密钥。

它不支持：浏览器宿主、Web
Worker、token 刷新、会话期间重新认证、吊销列表、密码、对称 JWT 算法、由代理转发的证书头、关闭 TLS 校验、向 runner 分发代码、runner 故障转移，以及调用重放。

如果这些选项都不满足需求，可以[编写自己的传输或认证](../capabilities/)。
