---
title: 远程插件
description: 在子进程、Node worker 或 runner 上运行插件。
---

用 `name: remote` 把插件放到宿主之外执行。可以选本机子进程、Node
worker，或连接 runner。消费者仍然注入普通 Graft 服务；提供者撤回时，它们也随之停止。

Remote 隔离的是执行，不是权限。需要权限边界时请用容器或虚拟机；同一进程里的服务可见性用[隔离](../isolation/)控制。
[06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote)演示 local 和 worker；[chat-bot 示例](https://github.com/graftland/graft/tree/main/samples/chat-bot)把天气集成放进子进程。

## 定义契约

宿主只导入契约。契约的 `module`
指向另一个实现模块，它导出普通 Graft 插件。启动子进程或 worker 前，先把两者构建为 JavaScript；它们不会使用宿主的 TypeScript
loader。

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract: Contract.Contract<typeof config, typeof Schema.Never> =
	Contract.make({
		name: "greeter",
		config,
		error: Schema.Never,
		module: new URL("./worker.js", import.meta.url).href,
	})
```

```ts title="worker.ts"
import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config } from "./contract.js"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
```

契约可以导出为 `contract` 或
`default`。配置必须能编码为 JSON；契约的 codec 不能依赖外部服务。预期内的失败放在契约的
`error` schema 里。

## 从 YAML 或 TypeScript 加载

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

运行 `graft start`，不需要另写能力 entry 或服务键字符串。要用 Node worker，把
`local: {}` 换成 `worker: {}`。TS 使用同样的 `connect` 数据和业务 `config`：

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

用 `Graft.plugin(entry)` 加载。`contractModule`
告诉子进程或 runner 去哪里读契约，与契约中指向实现的 `module`
不同。自己嵌入 Graft 时，在构建 `Graft.layer` 的环境中提供 `NodeServices.layer`
和 `SecureRandom.layerWebCrypto`；CLI 已提供。也可以在这个环境里提供 loader 的
`ModuleResolver` 和 `ConfigDirectory`。

连接 runner 时，两边都要安装契约包：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        mtls:
          cert: ./certs/client-billing.crt
          key: ./certs/client-billing.key
      lease: 30 seconds
    config:
      greeting: Hello
```

把 `RUNNER_URL` 设为 `wss://runner.example:7443`，然后运行
`graft start --config host.yml`。相对路径以配置文件所在目录为准，不是 cwd。证书、私钥、CA 的字符串都是文件路径；token 字符串是值本身，读文件要写
`{ file: "./token.txt" }`。同一处只能选择一种传输和一种认证写法。

`connect` 也支持
`unix: /run/graft.sock`、`command: [ssh, runner.example, graft-remote, serve, --config, /srv/stdio.yml]`、`local: { command: [node, /path/to/bin.js] }`
和 `worker: { execArgv: [] }`。command 还可以写 `cwd` 和 `env`。

TS 额外允许用 Effect 读取凭证，每次连接读取一次：

```ts
import { Config } from "effect"

Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

凭证来自服务时，可把 Effect 换成
`{ inject: [Vault], read: Vault.pipe(...) }`。token Effect 返回
`Redacted<string>`；mTLS Effect 返回包含 PEM 的
`{ cert: string, key: Redacted<string> }`。Remote 为它创建凭证子插件，显式注入这些依赖；依赖撤回会停止代理。`retry`
写在 `Remote.plugin` 的选项里；RPC 调用不会自动重试。

| `connect` 选项 | 默认值与含义                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`     | loader 条目 id；显式值优先。两者都没有时失败为 `MissingInstance`。                                                                           |
| `lease`        | runner 默认值，通常是 15 秒。宿主可以为这个实例覆盖它。                                                                                      |
| `margin`       | 5 秒；在租约之外多等这么久，获取退出确认。                                                                                                   |
| `expect`       | 默认不检查。`{ version, digest }` 可在激活前强制检查版本、摘要或两者。摘要仅在请求时计算，覆盖包自身除 `node_modules` 外的文件，不覆盖依赖。 |

loader 会把生成的条目 id 写回 YAML，请跨重启保留它。子插件继承
`Entry.CurrentId`：同一条目 fork 出两个 runner 代理时，需要不同的显式 instance，否则它们会互相替换。直接嵌入的
`Group.Group`
只要求兄弟 id 唯一。多个宿主共用认证身份和 instance 名时，也是在操作同一个 runner 实例。

## 跨边界使用服务

用 `Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述服务，再放入 `Contract.make`：

- `inject`：实现需要的宿主服务。
- `provides`：实现发布给宿主消费者的服务。

只有声明过的服务会跨边界。服务键和 RPC
schema 必须一致；一个契约内服务键不能重复，不同服务的 RPC 方法名可以重复。[示例契约](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)展示了如何在
`fromClient` 中把 `RpcClientError` 映射成服务自己的错误。

正常撤回时，先结束消费者；连接健康时，它们的 finalizer 仍可调用远程服务。宿主依赖撤回会停止代理，依赖回来后再恢复。子插件撤回导出的服务，也会停止宿主消费者。连接故障可能中断调用和 finalizer。

## 配置 runner

在 Linux 或 macOS 上使用 Node.js
22.22 或更新版本。安装 remote、构建后的插件包及其依赖。runner 在 `root`
下解析契约包名，宿主不会上传代码；运行时不要修改安装目录。建议由外部 supervisor 管理 runner 及全部后代进程，例如 systemd 的
`KillMode=control-group`。

```yaml title="runner.yml"
- id: runner
  name: remote/runner
  config:
    root: ./installation
    state: ./state
    lease: 15 seconds
    grace: 5 seconds
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth:
          mtls:
            ca: ./certs/ca.crt
      - unix: ./runner.sock
        auth:
          none:
            identity: billing
```

```sh
graft-remote serve --config runner.yml
```

`serve` 只接受 `--config`。一个 runner
entry 管理一个 supervisor 和全部 listener，它们共享实例命名空间。所有 listener 就绪才算启动成功；启动失败会关闭已打开的资源，运行期间一个 listener 失败则不会停止其他 listener 或 supervisor。一个 runner 只能配置一个 JWT 签发者；声明 issuer 的第三方认证器也受此约束。bearer 的 token 文件不算签发者。

每个 entry 都有私有的能力提供者。同一种能力可以在两个 entry 中用不同配置。第三方插件写成
`transport: { name: "my-connector", config: {...} }` 或
`auth: { name: "my-authenticator", config: {...} }`；name 按应用的 loader 规则解析，内置简写也展开成同样的引用。

wss 需要服务器证书和受信任 CA；mTLS 的客户端证书由专用 CA 签发：

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

也可使用其他工具。运维保管
`ca.key`；服务器证书和私钥部署到 runner，`client-billing.crt`/`.key`
部署到宿主，两边都需要
`ca.crt`。服务器证书须匹配主机名。mTLS 客户端证书须有恰好一个 `graft://` SAN
URI，例如 `graft://billing`；允许其他 URI
SAN 共存。轮换证书时保持身份不变，就能保留实例命名空间。

`state`
必须放在本地文件系统上，同一时间只能由一个 supervisor 持有。跨重启保留它，其中记录了 generation 和未完成的执行。不要用空状态目录复用仍在运行的部署身份。

## 选择传输与认证

| `connect` / runner listener    | 认证                           | 保证与 WARN                                                                                       |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `local: {}`                    | 不可写 `auth`                  | 独立进程，普通 OS 权限；无传输 WARN。                                                             |
| `worker: {}`                   | 不可写 `auth`                  | 与宿主同进程，只隔离执行，**不隔离权限**；无传输 WARN。                                           |
| `url: wss://…`                 | mtls、bearer、jwt、none        | 加密，验证服务器证书。none 在 runner 启动和每次连接时 WARN。                                      |
| `url: ws://…`                  | bearer、jwt、none              | 不加密。runner 启动、宿主连接时 WARN；使用 token 时明确提示凭证以明文传输。none 还会逐连接 WARN。 |
| `unix: …`                      | bearer、jwt、none              | 依赖文件权限，不读取对端凭证；无传输或认证 WARN。                                                 |
| `command: […]` / `stdio: true` | 不可显式写 `auth`，none 也不行 | 认证和加密由 SSH 等外部命令负责。                                                                 |

省略 auth 就是 none，runner 默认身份为
`anonymous`。网络 listener 会 WARN；所有调用者共享这个身份。mTLS 只支持 wss。ws 不写 cert/key，wss 必须同时写两者。WebSocket 路径为
`/graft`，子协议为 `graft-remote.v1`；没有其他 HTTP 端点或健康检查。

- **Bearer**：宿主 `auth: { bearer: { token: "value" } }`；runner
  `auth: { bearer: { tokens: "./tokens.json" } }`。文件为 SHA-256 十六进制摘要到身份的映射：`{ "<sha256 hex>": "billing" }`，不保存明文 token。
- **JWT**：宿主 `auth: { jwt: { token: { file: "./token.txt" } } }`。runner 用
  `auth: { jwt: { issuer: "https://issuer.example", audience: [graft], algorithms: [ES256], keys: { publicKey: "./public.pem" } } }`；JWKS 则用
  `keys: { jwksUrl: "https://issuer.example/jwks" }`。`identityClaim` 默认
  `sub`，`clockTolerance` 默认 `5 seconds`。身份 claim 必须是非空字符串，`exp`
  必填，存在 `nbf` 时也会验证。
- **None**：runner 的 `auth: { none: { identity: billing } }`
  只指定名字，不认证调用者。

缺失或无效的 bearer/JWT 在 upgrade 前返回 401 和
`WWW-Authenticate`。JWT 只在这时验证，连接期间过期不会断开。token 被盗后在有效期内可以重放；建议用 wss 和较短的有效期。

stdio 只写一个 `listen`
元素：`{ stdio: true, identity: billing }`，不能与其他 listener 共存。stdout 只写协议字节，日志去 stderr。EOF 后先停止执行单元、确认退出、释放状态锁，再以 0 退出；清理失败保留 cause 并非零退出。同一状态目录的并发调用会失败。认证交给 SSH
`authorized_keys` 强制命令等外部机制。SSH 退出本身不代表远端执行单元已经退出。

Remote 信任 runner 的安装、配置、OS、本机权限、专用 CA 以及配置的 JWT 签发者和密钥。不支持浏览器宿主、Web
Worker、token 刷新、连接期间重新认证、吊销列表、密码、对称 JWT、代理转发的证书头、关闭 TLS 校验、代码分发、runner 故障切换或调用重放。

## 通过 SSH 连接

在 runner 上安装插件包，为这个 SSH 身份使用独立的状态目录。配置里只放一个 stdio
listener：

```yaml title="stdio.yml"
- id: runner
  name: remote/runner
  config:
    root: /srv/graft/installation
    state: /srv/graft/state/billing
    listen:
      - stdio: true
        identity: billing
```

宿主使用 command 形式的 `connect`，YAML 也可以写同样的数组：

```ts
Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		command: ["ssh", "-T", "billing@runner.example"],
		instance: "greeter",
	},
	config: { greeting: "Hello" },
})
```

在 runner 账户的 `authorized_keys`
里，把这个公钥限定为固定命令。请换成实际部署的可执行文件路径和公钥：

```text
restrict,command="/usr/local/bin/graft-remote serve --config /srv/graft/stdio.yml" ssh-ed25519 AAAA... billing-host
```

不要分配终端，也不要把欢迎消息写到 stdout，它只承载协议字节。SSH 验证宿主身份，`identity`
指定稳定的 runner 身份名。同一状态目录不允许第二个调用并发运行。SSH 退出不等于执行单元已经停止。

## 替换与停止

对于同一认证身份和 instance，runner
**确认旧进程退出后**才接纳新实例。generation 持久化并递增，runner 恢复后也成立。无法确认退出就拒绝替换。插件从
`Remote.Instance` 读取
`{ id, generation }`；外部系统可拒绝旧 generation 的写入，即 fencing，但必须自行实施检查。它不会撤销已完成的写入，不保证调用恰好一次，也不协调不同 runner。local/worker 每次都是新 id、generation
1。

宿主续租；停止续租后执行单元到期退出，runner 消失也会触发退出。整机暂停会暂停期限执行，所以不是硬实时保证；进程身份检查还有很窄的 PID 复用窗口。后代进程仍由外部 supervisor 负责。

停止先走优雅 Dispose。`shutdownTimeout` 默认五秒，只约束这一步。之后：

- 本机子进程再有一秒自然退出；超时后强制终止，spawner 再过一秒升级到 SIGKILL 并确认退出。
- worker 同样等一秒，然后 `worker.terminate()`
  并等待线程确实退出。即使终止成功，超时仍记入清理错误。
- runner 连接最多等待租约加宿主 `margin`。runner 的 `grace`
  默认五秒，是从中断到强杀的窗口；`margin` 只是宿主额外等待确认的时间。

| 结果                           | 含义                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `Exited`                       | 正常停止，确认进程退出。                                                     |
| `Killed`                       | 确认强制终止，finalizer 可能没完成。                                         |
| `RemoteTerminationUnconfirmed` | 退出未确认，可能已断连，也可能连接仍在但 runner 无法确认。超时不是退出证明。 |

前两种写入带 instance、generation 的 `remote.termination`
日志，第三种是清理错误。正常断连不记 ERROR，异常连接记带 cause 和身份的 Warning。执行寿命由 Dispose 和租约决定，不仅取决于连接。负载过高可能丢日志，宿主会报告数量。

TS 代理暴露声明的错误、`Contract.UndeclaredFailure`、`RemoteWithdrawn`、带 cause 的
`RemoteError` 和 `MissingInstance`。dispose 返回
`Fork.CleanupError`，可在其 cause 里查找
`RemoteTerminationUnconfirmed`。defect 仍是 defect。YAML 错误还会标出 entry 与失败字段。

## 热重载

宿主 entry 重载会替换执行单元；runner 确认旧实例退出后才增加 generation。**修改契约后需要重启宿主**，原始契约导入不参与 HMR。runner 的实现模块不在宿主 HMR 图中；在 runner 上部署，再重启代理。

## 编写能力插件

[能力作者指南](../remote-capabilities/)介绍四个服务契约、握手和可复用的符合性测试。内置
`host/*`、`runner/*` 也实现同样的契约；应用不需要把它们逐个写成 entry。
