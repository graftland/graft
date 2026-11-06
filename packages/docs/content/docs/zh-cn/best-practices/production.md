---
title: 在生产环境中运行
description: 启动、保护、监控、重新配置、停止和升级长期运行的 Graft 应用。
---

生产环境中的 Graft 应用是一个长期运行的进程：`graft start`，或者你自己基于
`Graft.layer` 编写的程序。它由服务管理器负责运行和重启，并通过 `SIGTERM` 停止。

## 不使用 `--watch` 启动

生产环境运行 `graft start graft.yml`，`--watch`
留给开发环境。所有选项见[命令行](../../cli/#graft-start)页面。

| 关注点                  | 不使用 `--watch`                                                | 使用 `--watch`                                                              |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 插件代码变化            | 需要重启。                                                      | [热重载](../../hot-reload/)，它[不适用于生产环境](../../hot-reload/#限制)。 |
| 手动编辑 `graft.yml`    | 在下次重启或下次 Loader 编辑时生效。                            | 保存即生效。                                                                |
| `--env-file` 的内容     | 只在启动时读取一次。                                            | [保存时重新读取](../../cli/#环境变量文件)。                                 |
| 启动时 `graft.yml` 无效 | 进程[以非零状态退出](../../cli/#初始配置无效)，部署会明确失败。 | 进程继续等待，不运行任何配置项。                                            |
| 失败的配置项            | 在发生变化时、按其 `retry` 调度，或由 `loader.retry` 重试。     | 每次模块重载后也会重试。                                                    |

给每个配置项写上 `id`，或者在 Graft
[写回缺失的 ID](../../config-file/#配置项字段)之后提交
`graft.yml`，这样只读文件或刚部署的文件就不会在启动时被改写。

## 传递密钥

用 `!env` 读取密钥，并解码为
`Redacted`，这样文件和日志中都不会出现密钥的值（见[类型与密钥](../../config-file/#类型与密钥)）。以文件形式挂载的密钥再加上
[`--env-dir`](../../cli/#环境变量目录)：

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL
```

```ts import.meta.vitest name="production: pass secrets"
import { Effect, Redacted, Schema } from "effect"

const config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
})

const { url } = await Effect.runPromise(
	Schema.decodeEffect(config)({ url: "postgres://app:secret@db/app" }),
)
String(url) // => "<redacted>"
Redacted.value(url) // => "postgres://app:secret@db/app"
```

| 规则                                        | 避免的问题                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 在进程环境中设置生产环境变量。              | 进程环境[优先于 `--env-file`](../../cli/#环境变量文件)，部署目录旁过期的 `.env` 无法覆盖它。 |
| 不要把 `.env` 提交到 Git。                  | `graft create` 生成的 `.gitignore` 会忽略它，请保留这一行。                                  |
| 不要公开 fork 树中的 `input`。              | `Graft.forks` 显示的是解析后、解码前的输入，`!env` 的值在那里是明文。                        |
| 用[健康检查](#报告健康状态)发现缺失的变量。 | 缺失的变量[只让所在配置项失败](../../config-file/#环境变量)，进程会继续运行。                |

## 重试不稳定的资源

没有 `retry` 的插件会一直停在 `Failed`，直到它的配置或依赖发生变化，或者有人运行
`loader.retry`。依赖网络资源的插件应使用这样的调度：永不放弃、限制最大延迟并加入随机抖动，避免共用同一个数据库的多个 fork 同时重连：

```ts import.meta.vitest name="production: retry flaky resources"
import { Effect, Ref, Schedule, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class ConnectionRefused extends Schema.TaggedError<
	ConnectionRefused,
	{ readonly brand: unique symbol }
>()("ConnectionRefused", {}) {}

// Stands in for a database that refuses the first connection.
const attempts = Ref.makeUnsafe(0)
const connect = Effect.flatMap(
	Ref.updateAndGet(attempts, (n) => n + 1),
	(n) => (n === 1 ? ConnectionRefused.make({}) : Effect.void),
)

const client = Plugin.make({
	name: "app/client",
	retry: Schedule.min([
		Schedule.exponential("1 second"),
		Schedule.spaced("1 minute"),
	]).pipe(Schedule.jittered),
	apply: () => connect,
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(client)
		yield* fork.state.pipe(
			Stream.map((state) => state._tag),
			Stream.takeUntil((tag) => tag === "Active"),
			Stream.runCollect,
		) // => ["Loading", "Failed", "Loading", "Active"]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

- 何时只在任务内重试单个调用、而不是重试整个 fork，见[让 fork 失败并重试](../effect/#让-fork-失败并重试)。
- 配置项没有 `retry` 字段，因此调度属于插件。`name: remote`
  配置项的情况见[控制失败范围](#控制失败范围)。

## 控制失败范围

一次失败会停止一个 activation，并重启使用其服务的消费者（见[服务撤回流程](../../services/#服务撤回流程)）。按可能出错的东西选择边界：

| 可能失败的东西                                            | 边界                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 两个各自独立失败的资源                                    | 拆成两个插件。[一个任务失败](../../plugins/#任务失败时)会让整个 activation 失败。 |
| 某个租户或实例的依赖                                      | 每个实例一个[领域](../../isolation/)。只有该领域中的消费者需要等待。              |
| 崩溃、内存泄漏、`process.exit` 或在 Effect 之外抛出的异常 | Remote `local`：一个[子进程](../../remote/overview/)。                            |
| 阻塞事件循环的 CPU 密集型工作                             | Remote `worker`：同一进程中的 Node worker。                                       |
| 另一台机器上的硬件、数据或网络                            | 一个 [runner](../../remote/runners/)。                                            |
| 代码被允许做什么                                          | 放在容器或虚拟机中的 runner；[Remote](../../remote/overview/) 不限制权限。        |

在 Effect 之外抛出的异常（例如在原生回调中）可能导致整个进程退出。在进程内，只有 Effect 的失败能被控制住。

YAML 中的 `name: remote` 配置项没有 `retry`，因此崩溃的子进程会一直停在
`Failed`，直到配置项变化或运行
`loader.retry`。要让它自动重启，请在一个模块中导出带 `retry` 的
`Remote.plugin`，然后加载这个模块：

```ts title="src/greeterHost.ts"
import { Schedule, Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ readonly greeting: typeof Schema.String }>
>

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	retry: Schedule.spaced("5 seconds"),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./dist/greeterHost.js
  config:
    greeting: Hello
```

## 报告健康状态

配置项失败或停在等待中都不会让进程退出，因此只盯着进程的服务管理器会认为应用一切正常。请把 fork 状态发布出来，供健康检查端点使用：

```ts title="health.ts"
import { Array, Context, Effect, Ref, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

export class Health extends Context.Service<
	Health,
	{ readonly unhealthy: Effect.Effect<ReadonlyArray<string>> }
>()("app/Health") {}

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

export const health = Plugin.make({
	name: "app/health",
	apply: () =>
		Effect.gen(function* () {
			const latest = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Graft.forks.pipe(
				Stream.runForEach((trees) => Ref.set(latest, unhealthy(trees))),
				Plugin.fork,
			)
			yield* Graft.provide(Health, { unhealthy: Ref.get(latest) })
		}),
})
```

将健康监控和这个路由插件与 [HTTP 服务器](../../http/)一起加载。挂载注入
`Health`，列表非空时返回 503：

```ts
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Health } from "./health.ts"

export default Plugin.make({
	name: "app/health-route",
	inject: [Health],
	apply: () =>
		Http.mount(
			HttpRouter.add(
				"GET",
				"/health",
				Effect.gen(function* () {
					const health = yield* Health
					const unhealthy = yield* health.unhealthy
					return HttpServerResponse.empty({
						status: unhealthy.length === 0 ? 200 : 503,
					})
				}),
			),
		).pipe(Effect.asVoid),
})
```

诊断插件树请参见[故障排查](../troubleshooting/)。

## 按配置项设置日志级别

只在排查期间调低正在排查的那个配置项的级别。设置方法见[按配置项设置级别](../observability/#按配置项设置级别)，输出 JSON 日志或追踪数据的方法见[在宿主中选择输出](../observability/#在宿主中选择输出)。

## 优雅停止

收到 `SIGTERM` 或 <kbd>Ctrl</kbd>+<kbd>C</kbd> 时，`graft start`
会卸载所有插件。发布服务的插件会等使用这些服务的消费者停止后再关闭，因此消费者的终结器仍然可以使用这些服务；见[服务撤回流程](../../services/#服务撤回流程)。

| 规则                                                                                    | 原因                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在 `apply` 中用 `Effect.acquireRelease` 或 `Effect.addFinalizer` 持有所有资源。         | 关闭时只会释放 `apply` 获取的资源。                                                                                                                                         |
| 在终结器或不可中断区域中完成进行中的工作。                                              | 消费者排空后任务会被中断，被中断的任务会丢失它的工作。                                                                                                                      |
| 把服务管理器的停止超时设得比最慢的终结器更长。                                          | `graft start` 没有整体的关闭超时。只有 `SIGKILL` 能提前结束卡住的停止过程。                                                                                                 |
| 远程插件的 finalizer 需要超过默认 5 秒时，在 `Remote.plugin` 上调大 `shutdownTimeout`。 | YAML 的 `remote` 配置项固定为 5 秒；要修改它，像[控制失败范围](#控制失败范围)中那样从模块导出一个 `Remote.plugin`。见[超时与默认值](../../remote/lifecycle/#超时与默认值)。 |

停止过程卡住时，见[停止迟迟不结束](../troubleshooting/#停止迟迟不结束)。

## 无需重启即可重新配置

通过 [Loader API](../../loader-api/)
修改运行中的应用，而不是重启它。只有发生变化的配置项会重新加载，其余配置项保留各自的连接和状态。哪些字段的变化会触发更新、哪些会触发重新加载，见[在运行期间修改配置](../../config-file/#在运行期间修改配置)；`remote`
配置项总是会重启它的插件进程。

- 编辑会写入
  `graft.yml`。部署时替换该文件会丢弃这些编辑，因此要么把部署后的文件当作状态来管理，要么把修改写回你的代码仓库。
- 运行中进程的环境无法从外部修改。轮换设置在进程环境中的密钥需要重启。`loader.retry`
  会[重新读取 `!env` 的值](../../config-file/#何时重新读取)，但只有在值的来源确实变化时才有用，例如使用
  `--watch` 时的 `--env-file` 或 `--env-dir`。
- 持有连接或缓存的插件应支持[原地更新](../../plugins/#原地更新)，这样修改配置时不会丢掉它们。

## 升级插件

`node_modules` 中的变化永远不会触发重新加载，无论是否使用
`--watch`。升级时先安装，再重启：

1. **安装**：运行
   `graft add <package>@<version>`。安装失败时，包文件会被恢复；见[回滚](../../cli/#回滚)。
2. **重启**进程。运行中的进程会继续使用它已经导入的模块。
3. **回滚**：用同样的方式安装上一个版本，然后重启。

| 规则                                         | 避免的问题                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| 在 `graft remove` 之前停用或删除对应配置项。 | `graft add <package>` 和 `graft remove` 只修改依赖；指向已移除包的配置项会加载失败。 |
| 不要在其他工具编辑项目时安装。               | 安装在完成前独占包文件；见[安装的独占性](../../cli/#安装的独占性)。                  |
| 把所有 `@graftland/*` 包升级到同一个版本。   | Graft 的所有包[使用同一个版本号](../../releases/#版本)发布。                         |
| 保持配置变更向后兼容，或者与新版本一起发布。 | 无法再解码的配置会让该配置项以 `SchemaError` 失败。                                  |

要在不重启的情况下替换插件代码，嵌入式宿主可以调用
[`Graft.replace`](../../replace/)；[checkout-upgrade](https://github.com/graftland/graft/tree/main/samples/checkout-upgrade)
示例演示了在负载下这样做。

## 嵌入而不使用 CLI

当你需要 `graft start`
不提供的东西时，就在自己的程序中运行 Graft：JSON 日志、tracer、一组固定打包的插件，或者由你现有服务器持有的服务。你需要自己构建环境，包括
`graft.yml` 用到的 intercept；嵌入的 loader 不会登记任何 intercept：

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: process.cwd(),
		importer: (specifier) => import(specifier),
	}).pipe(Layer.provide(NodeServices.layer)),
	Intercept.layer([
		Intercept.make(
			References.MinimumLogLevel,
			Schema.Literals(LogLevel.values),
			(_, level) => level,
		),
	]),
	Logger.layer([Logger.consoleJson]),
)
```

然后在 `Layer.provideMerge(Graft.layer, environment)` 中运行
`Include.Include`，做法见[加载配置文件](../../embedding/#加载配置文件)。

| 规则                                                           | 原因                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 把服务器自己的服务放进 `environment`。                         | 插件像注入其他服务一样注入它们，它们的生命周期与程序相同。               |
| 用 `NodeRuntime.runMain` 运行。                                | 它把 `SIGINT` 和 `SIGTERM` 转换为中断，于是 Scope 关闭，插件按顺序停止。 |
| 如果加载 `remote` 配置项，添加 `SecureRandom.layerWebCrypto`。 | Remote 需要它；`graft start` 会替你提供。                                |
