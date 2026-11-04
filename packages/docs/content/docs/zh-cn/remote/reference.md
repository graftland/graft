---
title: 参考
description:
  Remote 的所有配置字段、命令、默认值、超时和错误，以及每种错误的处理方法。
---

本页列出 Remote 的确切细节：配置字段及默认值、`graft-remote`
命令、超时，以及各种错误和处理方法。概念说明请从[概览](../overview/)开始。确切的 TypeScript 签名见
[API 参考](../../reference/plugin-remote/readme/)。

## 约定

- 配置文件中的**路径**相对于包含它的文件，而不是工作目录。证书、私钥、CA、token 和
  `tokens` 文件，以及 runner 的 `root` 与 `state` 都是如此。
- **证书、私钥和 CA** 总是文件路径。**token** 是一个值，或者用 `{ file: path }`
  从文件读取。
- **时长**是 `30 seconds`、`500 millis` 这样的字符串。`lease`、`grace` 和
  `margin` 必须是有限的正值；`clockTolerance` 可以为零。
- **各取其一。** 一个 `connect` 或 `listen` 元素恰好使用一种传输形式，最多一种
  `auth` 形式。

## 宿主条目

宿主以如下配置加载 `name: remote`：

| 字段       | 必填 | 含义                                                                           |
| ---------- | ---- | ------------------------------------------------------------------------------ |
| `contract` | 是   | 契约模块：相对于配置文件的路径、`file:` URL 或包名。通过 runner 时必须是包名。 |
| `connect`  | 是   | 插件在哪里、以什么方式运行。见下文。                                           |
| `config`   | 否   | 插件的配置，采用编码后的 JSON 形式，会用契约的 schema 校验。默认为 `{}`。      |

YAML 条目始终使用五秒的 `shutdownTimeout`，也没有 `retry`。修改 `config` 或
`connect` 会重启远程插件，它从不原地更新。

### `connect` 的形式

| 形式                            | 启动或连接到                                     | 附加字段                                                                            |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `local: {}`                     | 宿主上的子进程。                                 | `local.command`：代替内置 `graft-remote` 运行的命令，如 `[node, /path/to/bin.js]`。 |
| `worker: {}`                    | 宿主进程中的 Node worker。                       | `worker.execArgv`：传给 worker 的 Node 选项。                                       |
| `url: wss://…` 或 `url: ws://…` | runner 的 WebSocket listener。                   | `ca`：要信任的 CA 文件。`servername`：代替 URL 主机名进行校验的名称。               |
| `unix: path`                    | runner 的 Unix 套接字。                          | —                                                                                   |
| `command: [program, args…]`     | 由命令（如 SSH）启动、通过 stdio 通信的 runner。 | `cwd`、`env`。                                                                      |
| `transport: { name, config }`   | [自定义 connector](../capabilities/)。           | —                                                                                   |

`local` 和 `worker` 不接受其他字段：没有 `auth`、`instance`、`lease`、`margin`
或 `expect`。`command` 不接受 `auth`，`none` 也不行。

### 面向 runner 的 `connect` 选项

以下选项适用于 `url`、`unix`、`command` 和 `transport`：

| 选项       | 默认值                          | 含义                                                                           |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `instance` | loader 条目的 `id`              | runner 上的实例名。没有条目 id 时必须设置，否则加载以 `MissingInstance` 失败。 |
| `lease`    | runner 的 `lease`（通常 15 秒） | 为这个实例向 runner 申请这么长的租约。                                         |
| `margin`   | `5 seconds`                     | 在租约之外，宿主额外等待 runner 确认插件退出的时间。                           |
| `expect`   | 不检查                          | `{ version, digest }`，可任选其一或两者，在插件启动前检查。见下文。            |
| `auth`     | `none`                          | 宿主如何认证。见下文。                                                         |

`expect.version` 与 runner 上契约包 `package.json` 中的 `version`
比较。`expect.digest` 与包内文件的 SHA-256 十六进制摘要比较，摘要不包含任何
`node_modules` 目录，因此不覆盖依赖。只有设置了 `digest`
时 runner 才会计算它。不匹配时以 `PackageError` 失败，错误消息中会给出两个值。

### 宿主 `auth`

| 形式                  | 字段                                          |
| --------------------- | --------------------------------------------- |
| `mtls: { cert, key }` | 客户端证书与私钥文件。仅限 `wss`。            |
| `bearer: { token }`   | `token`：一个值，或 `{ file }`。              |
| `jwt: { token }`      | `token`：一个值，或 `{ file }`。              |
| `none: {}`            | 不出示任何东西。与省略 `auth` 相同。          |
| `{ name, config }`    | [自定义 credentials](../capabilities/) 插件。 |

`{ file }`
形式的 token 在每次连接时读取，文件的全部内容原样作为 token。末尾的换行符不会被去掉，会成为 token 的一部分。宿主以
`Authorization: Bearer <token>` 的形式发送 token。

使用 `Remote.plugin` 时，`mtls`、`bearer.token` 和 `jwt.token`
也可以是一个 Effect，或者是需要服务的 Effect 的 `{ inject, read }`
形式，每次连接运行一次。token 的 Effect 返回
`Redacted<string>`；mTLS 的 Effect 返回 PEM 格式的 `{ cert, key }`，其中 `key`
经过 redact。

## Runner 条目

runner 从传给 `graft-remote serve` 的文件中加载 `name: remote/runner`：

| 字段     | 必填 | 默认值       | 含义                                                                               |
| -------- | ---- | ------------ | ---------------------------------------------------------------------------------- |
| `root`   | 是   | —            | 安装目录。契约包从它的 `node_modules` 中解析。                                     |
| `state`  | 是   | —            | 状态目录，不存在时自动创建。必须在本地，同一时间只供一个 runner 使用，重启时保留。 |
| `lease`  | 否   | `15 seconds` | 实例的默认租约。宿主的 `connect.lease` 可以为该实例覆盖它。                        |
| `grace`  | 否   | `5 seconds`  | 从中断插件进程到杀掉它之间的时间。                                                 |
| `listen` | 是   | —            | listener 列表。见下文。                                                            |

### `listen` 的形式

| 形式                          | 字段                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `url: ws://host:port`         | 不写 `cert` 或 `key`。URL 的路径必须为空或 `/graft`。                                        |
| `url: wss://host:port`        | `cert` 与 `key`：服务器证书和私钥。路径要求同上。                                            |
| `unix: path`                  | 要创建的套接字文件。                                                                         |
| `stdio: true`                 | `identity`：给连接进来的宿主的名字，默认 `anonymous`。不可写 `auth`。必须是唯一的 listener。 |
| `transport: { name, config }` | [自定义 listener](../capabilities/)。                                                        |

一个 runner 的所有 listener 共享同一组实例，所有 listener 合起来最多使用一个 JWT 签发方。

### Runner `auth`

| 形式                 | 字段                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mtls: { ca }`       | 客户端证书必须链接到的 CA 文件。仅限 `wss`。身份取自证书中唯一的 `graft://` 主题备用名称 URI。                                                                                                                                                                                       |
| `bearer: { tokens }` | 一个 JSON 文件，把 token 的 SHA-256 十六进制摘要映射到身份：`{ "<sha256 hex>": "billing" }`。                                                                                                                                                                                        |
| `jwt: { … }`         | `issuer`（必填）、`audience`（必填，列表）、`algorithms`（必填，仅限非对称算法）、`keys`（必填：`{ publicKey: file }` 或 `{ jwksUrl: url }`）、`identityClaim`（默认 `sub`）、`clockTolerance`（默认 `5 seconds`）。`exp` 必须存在；有 `nbf` 时会检查；身份 claim 必须是非空字符串。 |
| `none: { identity }` | 不做任何检查，把 `identity`（默认 `anonymous`）赋给每个调用方。                                                                                                                                                                                                                      |
| `{ name, config }`   | [自定义 authenticator](../capabilities/)。                                                                                                                                                                                                                                           |

省略 `auth` 即为身份是 `anonymous` 的
`none`。缺失或无效的 bearer 与 JWT 凭证会在 WebSocket 打开之前收到 HTTP 401 和
`WWW-Authenticate`。

## `graft-remote`

`@graftland/plugin-remote` 包会安装 `graft-remote` 命令。

### `graft-remote serve`

```sh
graft-remote serve --config <file>
```

用给定的配置文件运行 runner。`--config`
是它唯一的参数。文件只读取一次，修改后需重启才能生效。日志写到标准错误。

- 只有所有 listener 都就绪，启动才算完成。启动失败时会关闭已经打开的资源，并带着原因以非零状态退出。
- `stdio`
  runner 在输入结束时，停止插件、确认退出并释放状态目录后以状态码 0 退出；如果这一过程失败，则带着原因以非零状态退出。

### `graft-remote certificates`

```sh
graft-remote certificates --out <dir> [--server <name>]... [--identity <name>]... [--days <n>] [--force]
```

| 参数         | 默认值 | 含义                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `--out`      | —      | 存放 CA 和所签发证书的目录。                                             |
| `--server`   | —      | runner 的 DNS 名称或 IP 地址，可重复指定多个。签发 `server.crt`/`.key`。 |
| `--identity` | —      | 宿主身份，可重复指定多个宿主。签发 `client-<identity>.crt`/`.key`。      |
| `--days`     | `365`  | 证书有效期。                                                             |
| `--force`    | 关闭   | 替换所请求的服务器和客户端证书。CA 永远不会被替换。                      |

第一次运行时创建 `ca.crt` 和 `ca.key`，之后的运行会复用它们。不加 `--force`
时，命令拒绝覆盖已有的证书。文件名中的身份经过 URI 编码。私钥文件以 `0600`
权限写入。

`graft-remote` 的其他形式供 Remote 内部使用，不属于公开接口。

## 超时与默认值

| 项目                          | 默认值             | 设置方式                                    |
| ----------------------------- | ------------------ | ------------------------------------------- |
| 插件的优雅停止                | 5 秒               | 仅限 `Remote.plugin` 的 `shutdownTimeout`   |
| 优雅停止后直连插件的退出时间  | 1 秒               | 固定                                        |
| `local`：终止后发送 `SIGKILL` | 再过 1 秒          | 固定                                        |
| 租约                          | 15 秒              | runner 的 `lease`，或宿主的 `connect.lease` |
| 租约续期                      | 每过租约的三分之一 | 固定                                        |
| runner 上从中断到杀掉         | 5 秒               | runner 的 `grace`                           |
| 宿主等待退出确认              | 租约 + 5 秒        | 宿主的 `connect.margin`                     |
| JWT 时钟容差                  | 5 秒               | runner 的 `jwt.clockTolerance`              |
| 证书有效期                    | 365 天             | `graft-remote certificates --days`          |

## `Remote.plugin` 选项

`Remote.plugin(contract, options)` 在 TypeScript 中构建远程插件。

| 选项              | 含义                                            |
| ----------------- | ----------------------------------------------- |
| `contractModule`  | 插件进程从哪里导入契约。不是契约的 `module`。   |
| `connect`         | 与 YAML 相同，另外支持 Effect 形式的凭证。      |
| `config`          | 插件配置的编码形式。                            |
| `shutdownTimeout` | 优雅停止的时限。默认 `5 seconds`。              |
| `retry`           | 失败后重启所用的 `Schedule`。调用本身从不重试。 |

## `Contract.make` 选项

| 选项       | 含义                                                                      |
| ---------- | ------------------------------------------------------------------------- |
| `name`     | 插件名。                                                                  |
| `config`   | 配置 schema。必须能编码为 JSON，且不依赖服务。                            |
| `module`   | 构建后实现的 URL，通常写作 `new URL("./impl.js", import.meta.url).href`。 |
| `error`    | 声明的失败的 schema。默认 `Schema.Never`。不能依赖服务。                  |
| `inject`   | 实现要用到的宿主服务，每个都用 `Contract.service` 描述。                  |
| `provides` | 实现向宿主发布的服务，每个都用 `Contract.service` 描述。                  |

`Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述一个服务。同一契约中服务键必须唯一。契约模块以 `contract`
或默认导出的形式导出契约。

## 错误

### 调用方和 `fork.await` 看到的

| 错误                         | 含义                                                                      | 怎么办                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 声明过的错误                 | 插件以契约 `error` schema 中的错误失败。                                  | 像处理其他插件错误一样处理。                                                                                                                         |
| `Contract.UndeclaredFailure` | 插件以契约未声明的错误失败，原始值在 `original` 中。                      | 在 `error` 中声明它，或在插件内部处理。                                                                                                              |
| `RemoteError`                | Remote 自身出错。`cause` 中有完整的 cause，可能包含的内容见下一张表。     | 查看 `cause`。                                                                                                                                       |
| `RemoteWithdrawn`            | 插件的服务已被撤回。                                                      | 停止和重启期间属于正常现象，消费者会先被停止。                                                                                                       |
| `MissingInstance`            | runner 连接既没有 `connect.instance`，也没有 loader 条目 id。             | 设置 `connect.instance`。                                                                                                                            |
| `RemoteEntryError`           | YAML 条目失败。`entry`、`directory` 和 `field` 指出是哪个条目、哪个字段。 | 修正该字段。字段包括 `contract`、`config`、`connect`、`connect.transport`、`connect.auth`，runner 上还有 `listen[n].transport` 和 `listen[n].auth`。 |

defect 仍然是 defect，Remote 不会把它们变成错误。

### `RemoteError` 中可能出现的

这些来自连接、插件进程或 runner：

| 错误                         | 含义                                                                    | 怎么办                                                              |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TransportError`             | 连接失败，`cause` 中是底层错误。                                        | 检查网络、地址和 TLS 设置。                                         |
| `CredentialsError`           | 读取宿主凭证失败，例如 token 文件不存在。                               | 检查 `cause` 中的凭证来源。                                         |
| `ProcessExited`              | 插件进程或 worker 意外退出，附带退出码和 stderr。                       | 查看 `stderr` 和 `statusCause`。                                    |
| `CommandExited`              | `command` 连接运行的程序退出了，附带退出码和 stderr。                   | 检查命令本身，例如 SSH 访问和强制命令。                             |
| `CapabilityCombinationError` | 传输与认证不匹配，例如在 `ws` 上用 mTLS，或给 `command` 写了 `auth`。   | 选择受支持的组合，见[选择传输与认证](../transport-auth/#所有组合)。 |
| `PackageError`               | runner 找不到、读不了或无法验证契约包，或者 `expect` 不匹配。           | 把包安装到 runner 的 `root` 下，或修正 `expect`。                   |
| `SessionAccessDenied`        | 会话属于另一个已认证的身份。                                            | 确保每个宿主使用自己的凭证。                                        |
| `StaleSession`               | 同一实例的另一次启动抢先了，或者 runner 已不认识这个会话或 generation。 | 检查是否有两个宿主共用同一身份和实例名。                            |
| `SessionConflict`            | 同一会话上出现了相互冲突的请求。                                        | 检查是否有两个宿主共用同一身份和实例名。                            |
| `LeaseExpired`               | 宿主续期之前租约就到期了。                                              | 检查网络；考虑加长 `lease`。                                        |
| `SessionStopped`             | 会话正在停止、已经停止，或在 runner 恢复期间被淘汰。                    | 实例正在被替换或 runner 正在恢复时属于预期情况。                    |
| `TerminationUnconfirmed`     | runner 无法确认某个插件进程已经退出。                                   | 在 runner 机器上检查该进程。替换会等待确认。                        |
| `RunnerClosing`              | runner 正在关闭。                                                       | 等它恢复。                                                          |
| `StateDirectoryLocked`       | 状态目录已被另一个 runner 占用，或无法加锁。                            | 每个状态目录只运行一个 runner。                                     |
| `StateStorageError`          | runner 无法读写自己的状态。                                             | 检查状态目录所在磁盘和权限。                                        |
| `ExecutionError`             | runner 无法启动、监视或停止插件进程。                                   | 查看 `detail` 和 runner 的日志。                                    |

### 清理错误

远程插件被 dispose 时，这些错误出现在 `Fork.CleanupError` 的 `cause` 中：

| 错误                           | 含义                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `RemoteTerminationUnconfirmed` | 宿主无法得到 runner 插件进程已退出的确认，进程可能仍在运行。                             |
| `LocalTerminationTimeout`      | `local` 子进程或 `worker` 在优雅停止后一秒内没有退出，因而被终止。即使终止成功也会报告。 |

### runner 与能力的错误

| 错误                      | 含义                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `StartupError`            | `graft-remote serve` 无法启动，原因见 `cause`。                            |
| `ListenerConfigError`     | listener 的传输与认证不匹配。                                              |
| `CapabilityContractError` | 某个能力插件进入激活状态却没有发布它的服务。                               |
| `AuthenticationFailed`    | 宿主的凭证 `missing`（缺失）或 `invalid`（无效），以 HTTP 401 返回给宿主。 |
| `ConformanceError`        | `@graftland/plugin-remote/Testing` 中的某项检查失败。                      |
| `CertificateExists`       | `graft-remote certificates` 会覆盖已有证书。可使用 `--force`。             |

## 日志

| 消息                                         | 由谁记录 | 含义                                                                      |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `Remote execution terminated`                | 宿主     | runner 上的插件进程已停止，`remote.termination` 为 `Exited` 或 `Killed`。 |
| `Remote logs were dropped`                   | 宿主     | 负载过高时丢失了部分插件日志，注解中有数量。                              |
| `Remote host connection failed`              | runner   | 某个宿主连接异常结束，注解中有宿主身份。                                  |
| `Remote listener failed`                     | runner   | 某个 listener 在启动后失败，其他 listener 继续运行。                      |
| `Superseded remote execution cleanup failed` | runner   | 清理被替换的插件进程时失败。                                              |
| 未加密和无认证的警告                         | 双方     | 见[警告的含义](../transport-auth/#警告的含义)。                           |

## 已发布模块

| 模块                                           | 内容                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `@graftland/plugin-remote`                     | `remote` 宿主插件（默认导出）、`plugin`、`Contract`、`Instance` 和公开错误。 |
| `@graftland/plugin-remote/runner`              | `remote/runner` 插件（默认导出）。                                           |
| `@graftland/plugin-remote/Contract`            | `Contract.make`、`Contract.service` 及相关类型。                             |
| `@graftland/plugin-remote/Errors`              | 错误类。                                                                     |
| `@graftland/plugin-remote/Auth`、`/Transport`  | 四种能力服务。                                                               |
| `@graftland/plugin-remote/Testing`             | 共享的能力检查。                                                             |
| `@graftland/plugin-remote/host/*`、`/runner/*` | 内置能力，见[列表](../capabilities/#内置能力模块)。                          |

`/internal/bin`、`/internal/worker` 和 `/internal/watchdog`
只是让 Remote 能找到自己的可执行文件，**不是公开 API**。runner 的 supervisor 和插件进程运行时同样属于内部实现。
