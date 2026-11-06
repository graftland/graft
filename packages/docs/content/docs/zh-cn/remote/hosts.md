---
title: 宿主条目
description: 用契约描述远程插件，并从 YAML 或 TypeScript 加载它。
---

宿主通过契约加载远程插件。契约是宿主唯一导入的模块，实现则在插件进程中运行。

在[契约](../contracts/)中定义共享协议，再在条目中独立指定实现。

使用[制品快照](../artifacts/)可让构建好的实现不受后续源码修改影响。

## 从 YAML 加载

把插件的条目换成 `remote` 条目。`name: remote` 会加载
`@graftland/plugin-remote`，所以请在应用中安装它。

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    implementation: ./dist/greeter.js
    connect:
      local: {}
    config:
      greeting: Hello
```

| 字段             | 含义                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `contract`       | 相对于配置文件的路径、`file:` URL 或包名。通过 runner 时只能是包名。                     |
| `implementation` | 构建后的实现模块。直接执行可用相对配置文件的路径、file URL 或包导出；runner 使用包导出。 |
| `connect`        | 插件在哪里运行，取下表中的一种形式。                                                     |
| `config`         | 插件自己的配置，采用编码后的 JSON 形式，在一切启动之前按契约的 schema 检查。默认 `{}`。  |

| `connect` 形式                | 插件运行在                             | 其他字段                                                                          |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `local: {}`                   | 宿主上的子进程。                       | `local.command` 替换自带的内部 child 入口，如 `[node, /path/to/childMain.js]`。   |
| `worker: {}`                  | 宿主进程中的 Node worker。             | `worker.execArgv`：传给 worker 的 Node 选项。                                     |
| `url: wss://…` 或 `ws://…`    | runner 的 WebSocket listener。         | `ca`：代替 Node 内置 CA 的信任 CA 文件。`servername`：代替 URL 主机名的校验名称。 |
| `unix: path`                  | runner 的 Unix 套接字。                | —                                                                                 |
| `command: [program, args…]`   | 由命令（如 SSH）启动的 runner。        | `cwd`、`env`。                                                                    |
| `transport: { name, config }` | [自定义 connector](../capabilities/)。 | —                                                                                 |

- `local` 和 `worker` 不接受其他字段：没有 `auth`、`instance`、`lease`、`margin`
  或 `expect`。
- 面向 runner 的形式还接受
  `auth`（[传输与认证](../transport-auth/)）、`instance` 和
  `expect`（[Runner](../runners/#实例)），以及 `lease` 和
  `margin`（[替换与停止](../lifecycle/#超时与默认值)）。
- 路径相对于配置文件，而不是工作目录。
- YAML 条目的 `shutdownTimeout` 固定为 5 秒，也没有 `retry`。

## 从 TypeScript 加载

`Remote.plugin` 在代码中构建同样的插件，交给 `Graft.plugin`：

```ts title="src/entry.ts"
import { Effect, Schema } from "effect"

import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ greeting: typeof Schema.String }>
>

const greeter = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	implementation: new URL("./greeter.js", import.meta.url).href,
	connect: { local: {} },
	shutdownTimeout: "5 seconds",
})

export const program = Effect.gen(function* () {
	const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* fork.await
	yield* fork.update({ greeting: "Hi" })
	yield* fork.await
})
```

工厂只固定部署选项。业务配置传给 `Graft.plugin`；调用 `fork.update`
会先停止旧执行单元，再用新配置启动一个新的执行单元。

| 选项              | 含义                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `contractModule`  | 执行单元从哪里导入契约。                                                                 |
| `implementation`  | 构建后的实现模块。直接执行可用相对配置文件的路径、file URL 或包导出；runner 使用包导出。 |
| `connect`         | 与 YAML 相同，另外支持[凭证 Effect](../transport-auth/#凭证来源)。                       |
| `shutdownTimeout` | 优雅停止的时限，默认 `5 seconds`。                                                       |
| `retry`           | 插件失败后重启所用的 `Schedule`。调用本身从不重试。                                      |

`graft start` 已经提供 Remote 所需的一切。如果你自己构建
`Graft.layer`，请在它的环境中提供 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`，也可以再提供 loader 的 `ModuleResolver` 和
`ConfigDirectory`。

## 跨边界的服务

| 规则           | 说明                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| **Provides**   | 实现用 `Graft.provide` 发布这些服务，宿主插件照常注入。                        |
| **Inject**     | 实现注入这些宿主服务，拿到的是一个回调宿主的客户端。                           |
| **等待**       | `remote` 条目像其他有依赖的插件一样，等待它的 `inject` 服务。                  |
| **宿主撤回**   | `inject` 中的宿主服务被撤回时，远程插件停止，直到服务回来。                    |
| **插件撤回**   | 宿主上的使用方停止。撤回之后发起的调用以 `RemoteWithdrawn` 失败。              |
| **停止顺序**   | 使用方先于服务撤回而停止，与[服务撤回流程](../../services/#服务撤回流程)一致。 |
| **连接断开**   | 随时可能中断调用和 finalizer。                                                 |
| **只限声明的** | 契约中没有列出的服务不会跨越边界。                                             |

## 调用方看到的错误

调用方和 `fork.await` 看到的是这些：

| 错误                         | 含义                                                                       | 怎么办                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 声明过的错误                 | 插件以契约 `error` schema 中的错误失败。                                   | 像处理其他插件错误一样处理。                                                                                                                 |
| `Contract.UndeclaredFailure` | 插件以未声明的错误失败，`original` 中是原错误。                            | 在 `error` 中声明它，或在插件内部处理。                                                                                                      |
| `RemoteError`                | Remote 本身失败。`cause` 中是具体错误；runner 的错误也从这里到达，见下表。 | 读 `cause`。                                                                                                                                 |
| `RemoteWithdrawn`            | 使用期间插件的服务被撤回。                                                 | 停止和重启期间属于正常现象。                                                                                                                 |
| `MissingInstance`            | runner 连接既没有 `connect.instance`，也没有条目 id。                      | 设置 `connect.instance`。                                                                                                                    |
| `RemoteEntryError`           | YAML 条目无效，`entry`、`directory` 和 `field` 指出位置。                  | 修正该 `field`：`contract`、`config`、`connect`、`connect.transport`、`connect.auth`，或 runner 的 `listen[n].transport`、`listen[n].auth`。 |

上表的公开错误都从包根导出。缺陷仍然是缺陷。下面这些嵌套标签是
`RemoteError.cause` 携带的诊断信息：

| 错误                         | 含义                                                              | 怎么办                                  |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `TransportError`             | 连接失败，`cause` 中是底层错误。                                  | 检查网络、地址和 TLS 设置。             |
| `CredentialsError`           | 读取宿主凭证失败，例如 token 文件不存在。                         | 检查 `cause` 中的来源。                 |
| `ProcessExited`              | 插件进程或 worker 意外退出，附带退出码和 stderr。                 | 读 `stderr` 和 `statusCause`。          |
| `CommandExited`              | `command` 的程序退出，附带退出码和 stderr。                       | 检查 SSH 访问和强制命令。               |
| `CapabilityCombinationError` | 传输和认证不匹配，例如在 `ws` 上用 mTLS。                         | 见[组合](../transport-auth/#组合)。     |
| `PackageError`               | runner 找不到、读不了或校验不了契约包或实现包，或 `expect` 不符。 | 把包安装到 `root` 下，或修正 `expect`。 |
| `SessionAccessDenied`        | 会话属于另一个身份。                                              | 让每个宿主使用自己的凭证。              |
| `StaleSession`               | 同一实例的另一次启动抢先了，或 runner 已不认识这个会话。          | 检查是否有两个宿主共用身份和实例名。    |
| `SessionConflict`            | 同一会话上的请求相互冲突。                                        | 同上。                                  |
| `LeaseExpired`               | 宿主续期之前租约就到期了。                                        | 检查网络，或使用更长的 `lease`。        |
| `SessionStopped`             | 会话正在停止、已经停止，或在 runner 恢复期间被淘汰。              | 替换或恢复期间属于预期情况。            |
| `TerminationUnconfirmed`     | runner 无法确认插件进程已经退出。                                 | 检查 runner 所在机器。替换会一直等待。  |
| `RunnerClosing`              | runner 正在关闭。                                                 | 等它恢复。                              |
| `StateDirectoryLocked`       | 状态目录被另一个 runner 占用，或无法加锁。                        | 每个状态目录只运行一个 runner。         |
| `StateStorageError`          | runner 无法读写自己的状态。                                       | 检查磁盘和权限。                        |
| `ExecutionError`             | runner 无法启动、监视或停止插件进程。                             | 读 `detail` 和 runner 的日志。          |

## 配置变更与热重载

| 修改内容                                               | 结果                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 通过 `fork.update` 或 YAML 修改业务配置                | 执行单元重启，不会原地更新。                                                                           |
| YAML 中的 `implementation` 或 `connect`                | 先停止旧执行单元，再建立新连接。                                                                       |
| `graft start --watch` 下 local/worker 的契约或实现文件 | 对应的远程 fork 用新代码重启，也会观察契约导入的依赖。入口指向构建后的 JavaScript 时，需要先重新构建。 |
| 网络 runner 上的实现                                   | 宿主不观察它。在 runner 上安装新代码，再重启条目。                                                     |

即使导入、契约校验或启动失败，观察也会保留到条目被移除或禁用。修复已知的契约、依赖或实现文件会重试条目；成功导入后会替换旧依赖。观察器失败会记录日志并重试，仍以原来的文件摘要比较，因此恢复期间的修改也会触发重启。

未启用 `--watch` 时，重新构建契约后需要重启宿主。
