---
title: 远程插件
description: 让插件在子进程、Node worker 或 runner 上运行。
---

用 `@graftland/remote` 将插件放到独立执行单元中。`Remote.local()`
启动本机 Node.js 子进程，`Remote.worker()` 启动 Node
worker，`Remote.runner(...)`
连接另一台机器上的 runner。宿主加载的仍是普通 Graft 插件：消费者等待服务，服务撤回时重启，并在提供者之前停止。

进程分开不代表权限隔离。插件仍能访问所在机器的文件和网络；需要限制权限时，请在部署中使用容器或虚拟机。同一进程内的服务可见性则由[隔离](../isolation/)控制。

[remote-worker 示例](https://github.com/graftland/graft/tree/main/samples/remote-worker)
包含完整的服务、宿主、子进程和测试，不需要网络或证书。[remote-runner 示例](https://github.com/graftland/graft/tree/main/samples/remote-runner)
通过 wss 和 JWT 在真实 runner 上运行 `graft.yml`
条目，并演示 generation 如何拒绝过期写入。

## 分开契约和实现

宿主只导入契约。把实现放在另一个模块，避免宿主导入入口时就加载或运行它：

```ts title="contract.ts"
import { Contract } from "@graftland/remote"
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
`default`，实现模块导出一个插件。两边的配置 Schema 须一致，配置须能编码成 JSON。预期的插件错误写在契约的
`error` Schema 中。契约的 codec 不能依赖外部服务。

启动子进程或 worker 前，先把这两个模块编译成 JavaScript。两者都不会使用宿主的 TypeScript
loader。

## 加载所需的能力插件

remote 两端都是普通 Graft 插件。`Remote.plugin`
根据 target 注入所需能力，不会自动安装提供者。缺少提供者时，代理保持 Pending；撤回传输或凭证提供者，也会撤回依赖它的代理。

公共契约模块 `@graftland/remote/Transport`、`Auth` 和 `Supervisor`
只定义服务键和接口，不包含实现。`Auth.Peer`
表示认证后的身份。用 YAML 的模块名加载实现，或导入其 default export 后调用
`Graft.plugin`：

| 位置   | `@graftland/remote/` 下的插件路径                                               | 用途                                                             |
| ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 宿主   | `host/local`、`host/worker`                                                     | 创建子进程或 Node worker，不需要认证插件。                       |
| 宿主   | `host/websocket`、`host/unix`、`host/command`                                   | 通过所选传输连接 runner。                                        |
| 宿主   | `host/auth/mtls`、`host/auth/bearer`、`host/auth/jwt`、`host/auth/none`         | 准备所选凭证；command 不需要这些插件。                           |
| Runner | `runner/supervisor`                                                             | 管理执行单元、持久化 generation、租约和状态目录锁。              |
| Runner | `runner/websocket`、`runner/unix`、`runner/stdio`                               | 接纳宿主会话；多个网络 listener 共用 supervisor 的实例命名空间。 |
| Runner | `runner/auth/mtls`、`runner/auth/bearer`、`runner/auth/jwt`、`runner/auth/none` | 将凭证对应到稳定身份；stdio 不使用认证器。                       |

同一 realm 中，一个服务键只能有一个提供者。listener 的 `auth` 填完整服务键，例如
`@graftland/remote/Auth/JwtAuthenticator`，不是条目 id。撤回认证器会关闭相应 listener，supervisor 继续运行。

## 启动本机子进程或 Node worker

```ts title="entry.ts"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

与入口一起加载 `host/local`：

```yaml title="graft.yml"
- name: "@graftland/remote/host/local"
- name: ./entry.ts
  config:
    greeting: Hello
```

使用 Node worker 时，将 target 改成 `Remote.worker()`，能力插件改成
`host/worker`。它共享宿主进程和权限；转发的 Effect 日志用 `remote.threadId`
定位，不使用独立 PID。

用 `Graft.plugin(entry, { greeting: "Hello" })` 或 [graft.yml](../config-file/)
加载入口。自行嵌入 Graft 时，在构建 `Graft.layer` 的环境中提供
`NodeServices.layer` 和 `effect/crypto` 的
`SecureRandom.layerWebCrypto`；CLI 已提供这两项服务。已安装或构建好的
`@graftland/remote` 可执行文件会负责启动子进程。

每次激活都有新的进程，配置变化也会重启它。子进程失败会使宿主代理失败；重试策略设在代理上，每次重试重新启动进程。Effect 日志会转发到宿主，并带上
`remote.pid`。请用 Effect 记录日志，`console.log` 不会作为结构化日志转发。

## 跨进程使用服务

用 `Contract.service(key, rpcGroup, mapping)` 描述服务。RPC
group 定义请求参数、结果、错误和流；mapping 把这些调用接回平常的服务接口：

```ts
const formatter = Contract.service(Formatter, api, {
	toHandlers: (service) => ({
		Format: ({ text }: { readonly text: string }) => service.format(text),
	}),
	fromClient: (client) => ({
		format: (text) =>
			client
				.Format({ text })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						WorkerUnavailable.make({ cause }),
					),
				),
	}),
})
```

这里的 `Formatter`、`api` 和 `WorkerUnavailable` 定义在示例的
[契约模块](https://github.com/graftland/graft/blob/main/samples/remote-worker/src/contract.ts)。适配器把连接失败转成服务错误。请明确选择错误处理方式：即使本地方法不会失败，远程调用也可能因断连失败。调用不会自动重试。

在 `Contract.make` 中列出描述符：

- `inject: [hostService]`：宿主提供服务，子进程注入它的 key。
- `provides: [formatter]`：子进程发布服务，宿主插件注入它的 key。

只有声明过的服务才能跨越边界。两边的 key 和 RPC
Schema 必须匹配。契约中的服务 key 不能重复；不同服务的 RPC 方法名可以相同。

正常撤回时，宿主消费者先完成清理，子进程才停止。连接健康时，消费者的 finalizer 仍可调用远程服务。宿主依赖消失会让代理停止，等待依赖恢复。子进程撤回导出的服务也会停止宿主消费者。断连可能中断调用，因此无法保证 finalizer 中的 RPC 成功。

## 从 graft.yml 加载网络 worker

用相对路径指向宿主入口模块。`config` 仍然只放插件的业务输入：

```yaml title="graft.yml"
- name: "@graftland/remote/host/websocket"
- name: "@graftland/remote/host/auth/jwt"
- id: greeter
  name: ./greeter.ts
  config:
    greeting: Hello
```

入口通过 Effect Config 从环境变量读取 runner 设置：

```ts title="greeter.ts"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem } from "effect"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const ca = yield* Config.String("RUNNER_CA").pipe(
		Effect.flatMap((path) => fs.readFileString(path)),
	)
	return Remote.runner({
		transport: Remote.websocket({
			url: yield* Config.String("RUNNER_URL"),
			tls: { ca },
		}),
		auth: Remote.jwt(Config.Redacted("RUNNER_TOKEN")),
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

把 `my-plugin/contract` 换成你的契约导出，宿主和 runner 安装匹配的版本。
`expect: { version, digest }` 可在启动前强制检查任意一项或两项。 `RUNNER_URL`
是与服务端证书匹配的 wss URL，`RUNNER_CA` 是宿主上的 CA 文件路径，
`RUNNER_TOKEN` 是 JWT。配置和文件在激活时读取，导入模块不执行 I/O。

这些选项写在 `Remote.runner({ ... })` 中，与 `transport`、`auth` 同级：

| 选项       | 默认值和作用                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance` | 默认使用 loader 条目 id，显式字符串优先。两者都没有时以 `MissingInstance` 失败。                                                                        |
| `lease`    | 默认采用 runner 的 `--lease`，其默认值为 15 秒。宿主传入 `"30 seconds"` 等值会覆盖该实例的 runner 默认租约。                                            |
| `margin`   | 默认 `"5 seconds"`。宿主等待终止确认时，在租约之外额外留出的时间。                                                                                      |
| `expect`   | 默认不检查。`{ version, digest }` 可固定已安装的包，两项都可省略；只有请求 digest 时才计算摘要。摘要覆盖包自身的文件，排除 `node_modules`，不包含依赖。 |

loader 会把生成的条目 id 保存到 YAML，保留它就能在宿主重启后继续对应同一个实例。
`@graftland/loader` 的 `Entry.CurrentId` 是一个值为 `Option<string>`
的 Reference；条目内 fork 的子插件会继承它。因此，从同一条目 fork 两个 runner 代理、又都不写
`instance`，就会互相替换，请为它们指定不同名字。直接嵌入 `Group.Group`
时，id 只要求在兄弟条目之间唯一，不同 group 的 id 也可能冲突。多个宿主共用同一认证身份、手写相同的实例名时，同样会指向同一个实例。

## 选择传输与认证

| Target                                 | 可用认证                | 保护与警告                                                                                            |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `Remote.local()`                       | 不接受 `auth`           | 独立进程，使用正常操作系统权限；无传输 WARN。                                                         |
| `Remote.worker({ execArgv? })`         | 不接受 `auth`           | 共享宿主进程，只隔离执行，**不隔离权限**；无传输 WARN。                                               |
| `Remote.websocket({ url: "wss://…" })` | mtls、bearer、jwt、none | 加密并验证服务端证书；none 在 runner 启动和每次连接时 WARN。                                          |
| `Remote.websocket({ url: "ws://…" })`  | bearer、jwt、none       | 不加密；runner 启动和宿主连接时 WARN。bearer/JWT 警告明确说明凭证明文传输；none 另在每次连接时 WARN。 |
| `Remote.unix({ path })`                | bearer、jwt、none       | 文件权限控制访问，不读取对端凭证；无传输或认证 WARN。                                                 |
| `Remote.command(argv, { cwd?, env? })` | 不接受 `auth`           | 启动 stdio runner；认证和加密交给命令，例如 SSH。无传输或认证 WARN。                                  |

websocket、unix、command 放在 `Remote.runner({ transport, auth?, ... })`
里。local 和 worker 是直连 target，不经过 supervisor。websocket/unix 省略 auth 等同于
`Remote.none()`，仍须加载 `host/auth/none` 和
`runner/auth/none`。它们使用 runner 配置的身份，默认
`anonymous`；所有连接的宿主共用这个命名空间。

- **mTLS：** 两端加载 `auth/mtls`。runner 配置是
  `{ ca: "clients-ca.crt" }`。宿主用
  `Remote.mtls(Effect.succeed({ cert, key }))`，cert 是 PEM 字符串，key 是包装了 PEM 的
  `Redacted<string>`。只支持 wss。
- **Bearer：** runner 配置是
  `{ tokens: "tokens.json" }`。JSON 将 SHA-256 十六进制摘要映射到身份：
  `{ "<sha256 hex>": "billing" }`。宿主通过
  `Remote.bearer(Config.Redacted("RUNNER_TOKEN"))` 发送原始 token。
- **JWT：** 宿主用
  `Remote.jwt(Config.Redacted("RUNNER_TOKEN"))`。runner 配置一个
  `issuer`、`audience` 列表和非空的非对称 `algorithms` 白名单。密钥二选一：
  `keys: { jwksUrl: "https://issuer.example/jwks" }` 或
  `keys: { publicKey: "jwt-public.pem" }`（SPKI PEM）。 `identityClaim` 默认
  `sub`，所选 claim 的值必须是非空字符串；`clockTolerance` 默认
  `5 seconds`。`exp` 必填，`nbf` 存在时校验。
- **None：** runner 配置是
  `{ identity: "billing" }`，只是分配身份，不验证调用者。

每次连接读取一次凭证。凭证依赖服务时，可向 `Remote.jwt`、`Remote.bearer` 或
`Remote.mtls` 传入
`{ inject: [Credentials], read: Credentials.pipe(Effect.flatMap(...)) }`，依赖会并入代理的 inject。JWT 只在 upgrade 时验证一次，连接期间过期不会断开。bearer/JWT 缺失或无效时，在建立 WebSocket 前返回 401，带上
`WWW-Authenticate: Bearer`。

token 被盗后，在有效期内可以重放。建议使用 wss 和较短有效期。runner 信任配置的签发者和密钥。不做 token 刷新、连接期间重新认证、吊销列表、密码认证、对称 JWT，也不信任代理转发的证书头。不提供关闭 TLS 校验的选项。只支持 Node 宿主，不支持浏览器宿主或 Web
Worker。

WebSocket 使用 `/graft`（省略时自动补上）和 `graft-remote.v1`
子协议。没有其他 HTTP 端点，包括健康检查。

## 准备 runner

使用 Linux 或 macOS，以及 Node.js 22.22 或更高版本。在安装目录下预装
`@graftland/remote`、编译后的插件包及其依赖。runner 的 `contractModule`
从这里解析包名或子路径；宿主不会上传代码。运行期间不要修改已安装的包。

`serve --config` 加载普通 Graft 条目。下面是完整的 wss +
JWT 配置；文件里的相对路径以该配置文件所在目录为基准。

```yaml title="runner.yml"
- id: remote-supervisor
  name: "@graftland/remote/runner/supervisor"
  config:
    root: /srv/graft/install
    state: /var/lib/graft
    lease: 15 seconds
    grace: 5 seconds

- id: remote-auth
  name: "@graftland/remote/runner/auth/jwt"
  config:
    issuer: https://issuer.example
    audience: [graft]
    algorithms: [ES256]
    identityClaim: sub
    clockTolerance: 5 seconds
    keys:
      publicKey: /run/secrets/jwt-public.pem

- id: public
  name: "@graftland/remote/runner/websocket"
  config:
    url: wss://0.0.0.0:7443/graft
    cert: /run/secrets/server.crt
    key: /run/secrets/server.key
    auth: "@graftland/remote/Auth/JwtAuthenticator"
```

```sh
graft-remote serve --config runner.yml
```

命令行简写会生成等价的 supervisor、认证器和 listener 条目，不能与 `--config`
混用。重复 `--listen` 可启动多个共用认证方式的网络 listener：

```sh
# wss + mTLS
graft-remote serve --listen wss://0.0.0.0:7443 --auth mtls \
  --cert server.crt --key server.key --ca clients-ca.crt \
  --root /srv/graft/install --state /var/lib/graft

# ws + JWT (unencrypted)
graft-remote serve --listen ws://127.0.0.1:7080 --auth jwt \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft

# Unix socket + none
graft-remote serve --listen /run/graft/runner.sock --auth none --identity billing \
  --root /srv/graft/install --state /var/lib/graft

# One session over stdin/stdout
graft-remote serve --stdio --identity billing \
  --root /srv/graft/install --state /var/lib/graft
```

Bearer 使用 `--auth bearer --tokens tokens.json`。JWT 可用 `--jwt-jwks URL` 代替
`--jwt-public-key FILE`，支持重复 `--jwt-audience`、`--jwt-algorithm`，以及
`--jwt-identity-claim`、`--jwt-clock-tolerance`。认证专用参数必须与所选方式对应。ws 不接受 cert/key，wss 两项必填；ws 和 unix 均拒绝 mTLS。

stdio 独占 serve：一个进程只有一个 listener、一个会话，不接受 `auth`。身份默认
`anonymous`，认证交给外部机制，例如 SSH `authorized_keys`
中的强制命令。stdout 只包含协议字节，日志走 stderr。stdin 结束后，先停止执行单元并确认退出，再释放状态锁并正常退出；清理失败会保留 cause，以非零状态退出。同一状态目录上的第二个并发调用会失败。具体配置见示例的
[SSH 说明](https://github.com/graftland/graft/blob/main/samples/remote-runner/README.zh-CN.md)。单凭 SSH 进程退出，不能认定远端执行单元已经停止。

wss 需要服务端证书和受信任的 CA；mTLS 还需要由**专用 CA** 签发客户端证书。可以用
`graft-remote certificates --out certs --server runner.example --identity billing`，或任何满足这些要求的工具。`ca.key`
由运维保管。`server.crt`/`server.key` 部署到 runner；mTLS 的
`client-billing.crt`/`client-billing.key` 部署到宿主，两边配置相应的
`ca.crt`。TLS 验证服务端主机名。mTLS 客户端证书必须恰好有一个 `graft://` SAN
URI，例如 `graft://billing`；可以同时有其他 URI
SAN。轮换凭证时保留身份，就能继续使用原来的实例命名空间。

`--grace` 默认五秒，是 runner 请求中断后、升级为强制终止前的等待窗口。它与宿主的
`margin`
不同：后者延长的是等待退出确认的时间，不会给插件 finalizer 增加清理时间。

看到 `Listening`
日志即表示开始监听，其中带有实际端口。状态目录须位于本地文件系统，由一个 runner 独占。重启时保留它，它记录了实例代数和未结束的执行。不要给仍在使用的部署身份换一个空状态目录。

建议用外部进程管理器运行 runner，停止时覆盖整个进程组或容器，包括插件启动的后代进程。systemd 可设
`KillMode=control-group`。runner 信任它的 CA、安装目录、状态目录和操作系统，不是运行不可信插件的沙箱。

## 替换、租约和停止

对于同一认证身份下的同一实例 id，一个 runner 会**先确认旧进程已退出，再接纳新实例**。新实例获得更大的、持久化的 generation；runner 重启恢复后也遵循这个顺序。无法确认退出时，它会拒绝替换，不会假定旧进程已经结束。

宿主连接期间会续租。不再续租，执行会在租约到期后停止；runner 消失也会触发子进程停止。租约默认 15 秒，在正常调度下防止失联的子进程无限运行。整机暂停时，期限检查也会暂停，因此这不是严格的实时保证。检查进程退出也仍有一个很小的 PID 复用窗口。

插件内读取 `Remote.Instance` 可得到
`{ id, generation }`。外部系统可以用 generation 拒绝旧实例的写入，也就是 fencing，但必须由外部系统执行检查。它不能撤销已经发生的写入，也不保证调用恰好执行一次；不同 runner 之间不协调 generation。本机子进程和 Node
worker 每次得到新的 id 和 generation 1，不能把它当作持久化的 fencing token。

正常停止先等待插件 finalizer 和最后的日志。代理的 `shutdownTimeout`
默认五秒，只约束这一步优雅 Dispose。之后才是进程终止：

- 本机子进程还有一秒完成输出并自然退出。仍不退出时，清理会报告退出超时并终止它；进程启动器再等一秒后升级为 SIGKILL，并确认退出。
- Node worker 使用同样的一秒退出窗口；超时会记录清理错误，调用
  `worker.terminate()` 并等待实际退出。
- 连接 runner 的宿主最多等待协商后的租约加 `margin`
  来确认终止。runner 在强杀之前使用自己独立的 `--grace` 窗口。

runner 实例有三种可观察的停止结果：

| 结果                           | 含义                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `Exited`                       | 走正常停止流程，并已确认进程退出。                                                                     |
| `Killed`                       | 已确认强制终止；finalizer 不一定执行完。                                                               |
| `RemoteTerminationUnconfirmed` | 等过租约加余量后仍无法确认退出；既可能是断连，也可能是连接仍在但 runner 无法确认。超时不等于已经退出。 |

前两种记录在宿主日志的 `remote.termination` 中，同时带有 `remote.instance` 和
`remote.generation`；第三种出现在清理失败中，可用导出的
`Remote.RemoteTerminationUnconfirmed`
识别。即使最终进程停止了，清理错误仍会保留。过载时日志可能丢失，宿主会报告丢失数量。

宿主正常断开会结束会话，不记 ERROR。异常断开记 Warning，包含 cause 和对端身份，runner 继续服务。执行单元由 Dispose 和租约决定何时停止，不由连接本身决定。

## 处理失败

代理除了暴露契约中声明的错误，还可能报告：

- `Remote.Contract.UndeclaredFailure`：实现抛出了契约之外的错误，`original`
  保留诊断值。
- `Remote.RemoteWithdrawn`：子进程撤回了导出的服务，宿主消费者需要停止。
- `Remote.RemoteError`：启动或基础设施失败，`cause` 保留具体原因。
- `Remote.MissingInstance`：既没有显式实例名，也没有 loader 条目 id。

这些属于激活或后台失败。显式 dispose 则报告 `Fork.CleanupError`；在它的 `cause`
里检查清理与终止错误，包括
`Remote.RemoteTerminationUnconfirmed`。意外 defect 仍是 defect，超时不会把清理变成成功。

## 热重载

宿主入口重新求值会产生新的 Plugin 对象。[HMR](../hot-reload/)
会因此重启代理、替换执行；runner 实例在旧进程停止后获得新的 generation。runner 上安装的实现模块不在宿主 HMR 图里。要使用新实现，先部署到 runner，再重启代理。

这个包不负责自动分发代码、runner 故障转移或调用重放。
