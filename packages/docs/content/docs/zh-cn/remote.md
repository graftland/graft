---
title: 远程插件
description: 把插件放进子进程，或交给另一台机器运行。
---

用 `@graftland/remote` 把插件移出宿主进程。`Remote.local()`
启动本机 Node.js 子进程，`Remote.runner(...)`
连接另一台机器上的 runner。宿主加载的仍是普通 Graft 插件：消费者等待服务，服务撤回时重启，并在提供者之前停止。

进程分开不代表权限隔离。插件仍能访问所在机器的文件和网络；需要限制权限时，请在部署中使用容器或虚拟机。同一进程内的服务可见性则由[隔离](../isolation/)控制。

[remote-worker 示例](https://github.com/graftland/graft/tree/main/samples/remote-worker)
包含完整的服务、宿主、子进程和测试，不需要网络或证书。

## 分开契约和实现

宿主只导入契约。把实现放在另一个模块，避免宿主导入入口时就加载或运行它：

```ts title="contract.ts"
import { Contract } from "@graftland/remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
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

启动子进程前，先把这两个模块编译成 JavaScript。子进程不会使用宿主的 TypeScript
loader。

## 启动本机子进程

```ts title="entry.ts"
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
	shutdownTimeout: "5 seconds",
})
```

用 `Graft.plugin(entry, { greeting: "Hello" })` 或 [graft.yml](../config-file/)
加载入口。自行嵌入 Graft 时，宿主要提供 Node 平台服务，例如
`Layer.provideMerge(Graft.layer, NodeServices.layer)`。已安装或构建好的
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
- name: ./greeter.ts
  config:
    greeting: Hello
```

入口通过 Effect Config 从环境变量读取 runner 设置：

```ts title="greeter.ts"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem, Redacted } from "effect"
import { contract } from "my-plugin/contract"

const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const read = (name: string) =>
		Config.String(name).pipe(Effect.flatMap((path) => fs.readFileString(path)))
	return Remote.runner({
		host: yield* Config.String("RUNNER_HOST"),
		port: yield* Config.Port("RUNNER_PORT"),
		tls: {
			servername: yield* Config.String("RUNNER_SERVERNAME"),
			ca: yield* read("RUNNER_CA"),
			cert: yield* read("RUNNER_CERT"),
			key: yield* read("RUNNER_KEY").pipe(Effect.map(Redacted.make)),
		},
	})
})

export default Remote.plugin(contract, {
	target,
	contractModule: "my-plugin/contract",
})
```

把 `my-plugin/contract`
换成你的包导出的契约，宿主和 runner 安装相匹配的版本。三个证书变量都是宿主上的文件路径，`RUNNER_SERVERNAME`
必须与 runner 的服务端证书匹配。配置和文件在激活时读取，导入模块时不会执行 I/O。

不传 `instance` 时，runner
target 使用 loader 条目的 id。loader 会把生成的 id 保存到 YAML；保留它，宿主重启后就仍然对应同一个实例。显式
`instance` 优先。不经过 loader 又没传 `instance` 时，激活会以类型化错误
`MissingInstance` 失败。

## 准备 runner

使用 Linux 或 macOS，以及 Node.js 22.22 或更高版本。在安装目录下预装
`@graftland/remote`、编译后的插件包及其依赖。网络 target 的 `contractModule`
是从该目录解析的包名或包的子路径；宿主不会上传代码。运行期间不要修改已安装的包。

用**专用 CA**
签发服务端和客户端证书。TLS 验证服务端主机名，并要求客户端证书。客户端证书必须恰好包含一个 SAN
URI，例如
`graft://billing`。这个身份拥有一个实例命名空间；签发相同 URI 的证书，就授予相同访问权。续签时保留 URI，就能继续访问原来的实例。

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

看到 `Listening`
日志即表示开始监听，其中带有实际端口。状态目录须位于本地文件系统，由一个 runner 独占。重启时保留它，它记录了实例代数和未结束的执行。不要给仍在使用的部署身份换一个空状态目录。

建议用外部进程管理器运行 runner，停止时覆盖整个进程组或容器，包括插件启动的后代进程。systemd 可设
`KillMode=control-group`。runner 信任它的 CA、安装目录、状态目录和操作系统，不是运行不可信插件的沙箱。

## 替换、租约和停止

对于同一证书身份下的同一实例 id，一个 runner 会**先确认旧进程已退出，再接纳新实例**。新实例获得更大的、持久化的 generation；runner 重启恢复后也遵循这个顺序。无法确认退出时，它会拒绝替换，不会假定旧进程已经结束。

宿主连接期间会续租。不再续租，执行会在租约到期后停止；runner 消失也会触发子进程停止。租约默认 15 秒，在正常调度下防止失联的子进程无限运行。整机暂停时，期限检查也会暂停，因此这不是严格的实时保证。检查进程退出也仍有一个很小的 PID 复用窗口。

插件内读取 `Remote.Instance` 可得到
`{ id, generation }`。外部系统可以用 generation 拒绝旧实例的写入，也就是 fencing，但必须由外部系统执行检查。它不能撤销已经发生的写入，也不保证调用恰好执行一次；不同 runner 之间不协调 generation。本机子进程每次得到新的 id 和 generation
1，不能把它当作持久化的 fencing token。

正常停止会等待 finalizer、最后的日志和进程退出。清理期限默认五秒。网络实例有三种可观察的停止结果：

| 结果                           | 含义                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `Exited`                       | 走正常停止流程，并已确认进程退出。                             |
| `Killed`                       | 已确认强制终止；finalizer 不一定执行完。                       |
| `RemoteTerminationUnconfirmed` | 连接丢失，等过租约加余量后仍无法确认退出。超时不等于已经退出。 |

前两种记录在宿主日志的 `remote.termination` 中，同时带有 `remote.instance` 和
`remote.generation`；第三种出现在清理失败中。余量默认五秒。即使最终进程停止了，清理错误仍会保留。过载时日志可能丢失，宿主会报告丢失数量。

## 热重载

宿主入口重新求值会产生新的 Plugin 对象。[HMR](../hot-reload/)
会因此重启代理、替换执行；网络实例在旧进程停止后获得新的 generation。runner 上安装的实现模块不在宿主 HMR 图里。要使用新实现，先部署到 runner，再重启代理。

这个包不负责自动分发代码、runner 故障转移或调用重放。
