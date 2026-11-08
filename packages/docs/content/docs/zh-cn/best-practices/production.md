---
title: 在生产环境中运行
description: 启动、保护、监控、重新配置、停止和升级长期运行的 Graft 应用。
---

生产环境中的 Graft 应用是一个长期运行的进程：`graft start`，或者你自己基于
`Graft.layer` 编写的程序。它由服务管理器负责运行和重启，并通过 `SIGTERM` 停止。

## 不使用 `--watch` 启动

构建模块后运行 `graft start graft.yml`。不支持
`--watch`。配置、环境文件和已安装包在此次启动时读取；修改后重新构建并重启。

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

没有 `retry` 的插件会一直停在
`Failed`，直到它的配置或依赖发生变化。依赖网络资源的插件应使用这样的调度：永不放弃、限制最大延迟并加入随机抖动，避免共用同一个数据库的多个 fork 同时重连：

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

| 规则                                                                            | 原因                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 在 `apply` 中用 `Effect.acquireRelease` 或 `Effect.addFinalizer` 持有所有资源。 | 关闭时只会释放 `apply` 获取的资源。                                         |
| 在终结器或不可中断区域中完成进行中的工作。                                      | 消费者排空后任务会被中断，被中断的任务会丢失它的工作。                      |
| 把服务管理器的停止超时设得比最慢的终结器更长。                                  | `graft start` 没有整体的关闭超时。只有 `SIGKILL` 能提前结束卡住的停止过程。 |

停止过程卡住时，见[停止迟迟不结束](../troubleshooting/#停止迟迟不结束)。

## 无需重启即可重新配置

直接嵌入的应用可编辑 Loader，并显式刷新引用。CLI 进程需要在修改后重启。公开部署可在准备和恢复时重新解析原始引用，参见[单元](../../units/)。

## 升级插件

安装包后，重新构建应用模块并重启：

1. **安装**：运行
   `graft add <package>@<version>`。安装失败时，包文件会被恢复；见[回滚](../../cli/#回滚)。
2. **重启**进程。运行中的进程会继续使用它已经导入的模块。
3. **回滚**：用同样的方式安装上一个版本，然后重启。

| 规则                                         | 避免的问题                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| 在 `graft remove` 之前停用或删除对应配置项。 | `graft add <package>` 和 `graft remove` 只修改依赖；指向已移除包的配置项会加载失败。 |
| 不要在其他工具编辑项目时安装。               | 安装在完成前独占包文件；见[安装的独占性](../../cli/#安装的独占性)。                  |
| 把所有 `@graftland/*` 包升级到同一个版本。   | Graft 的所有包[使用同一个版本号](../../publishing/#版本)发布。                       |
| 保持配置变更向后兼容，或者与新版本一起发布。 | 无法再解码的配置会让该配置项以 `SchemaError` 失败。                                  |

要在不重启的情况下替换插件代码，请以[监听模式](../../cli/#监听模式)运行
`graft start`，或者提交一个[变更](../../transitions/)。

## 嵌入而不使用 CLI

当你需要 `graft start`
不提供的东西时，就在自己的程序中运行 Graft：JSON 日志、tracer、一组固定打包的插件，或者由你现有服务器持有的服务。你需要自己构建环境，包括
`graft.yml` 用到的 intercept；嵌入的 loader 不会登记任何 intercept：

```ts
import { Layer, Logger, LogLevel, References, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Intercept, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

const environment = Layer.mergeAll(
	NodeServices.layer,
	ModuleResolver.layer({
		base: "/app",
		control,
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

| 规则                                   | 原因                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| 把服务器自己的服务放进 `environment`。 | 插件像注入其他服务一样注入它们，它们的生命周期与程序相同。               |
| 用 `NodeRuntime.runMain` 运行。        | 它把 `SIGINT` 和 `SIGTERM` 转换为中断，于是 Scope 关闭，插件按顺序停止。 |

## 升级时保留网关会话

把上游会话放在网关[单元](../../units/)中，通过固定[绑定](../../bindings/)注入集成。使用[公开控制接口](../../control/)只替换集成。网关单元及其会话保持不变。

报告成功前记录结果和原生退出证据。Recovered 表示旧制品的新单元通过试运行。RecoveryFailed 表示集成不可用。Stuck 保留未解决的预留。[发布存储](../../application-releases/)独立于内核执行记录数据；控制接口不持久化部署历史。
