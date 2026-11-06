---
title: 日志与追踪
description: 在插件中写出有用的日志，并导出 Graft 创建的 span。
---

插件使用 Effect 自带的工具记录日志和追踪：`Effect.log*`、日志注解和 span。Graft 为每个插件写出的日志行加上注解，并把每次插件启动包在一个 span 中；两者输出到哪里由宿主决定。

## 选择日志级别

消息保持固定，把会变化的值放进注解，这样结构化输出才便于搜索和过滤：

```ts import.meta.vitest name="observability: annotate a log line"
import { Effect, Option, Stream } from "effect"

import { Graft } from "@graftland/graft"

interface Order {
	readonly id: string
}

const accepted = (order: Order) =>
	Effect.log("Order accepted").pipe(
		Effect.annotateLogs({ "shop.order": order.id }),
	)

const annotations = await Effect.runPromise(
	Effect.gen(function* () {
		yield* accepted({ id: "A-17" })
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.annotations)
	}).pipe(Effect.provide(Graft.layer)),
)
annotations // => Option.some({ "shop.order": "A-17" })
```

| 级别    | 用于                                                   | 示例消息                                 |
| ------- | ------------------------------------------------------ | ---------------------------------------- |
| `Error` | 已经处理、但需要有人查看的失败。                       | `Payment refused; order dropped`         |
| `Warn`  | 降级但仍在工作：使用了兜底值、正在重试、丢弃了某一项。 | `Sync failed; serving the last snapshot` |
| `Info`  | 运维人员默认想看到的内容：开始监听、已连接、已就绪。   | `Listening on 8080`                      |
| `Debug` | 排查单个插件所需的细节：每个请求、每条消息。           | `Received frame`                         |
| `Trace` | 即使在调试时也嫌太多的细节，例如载荷内容。             | `Frame bytes`                            |
| `Fatal` | 插件不要使用。插件的失败属于它的 fork，让它失败即可。  |                                          |

除非宿主或某个配置项修改了最低级别，否则它是
`Info`。低于该级别的日志不会到达任何 logger，`Graft.logs` 也收不到。

## 记录 Cause

把 `Cause` 作为参数传入，而不是传
`error.message`。logger 会保留完整的错误及其调用栈，而消息只留下一个字符串。按标签捕获的错误用
`Cause.fail` 包装：

```ts import.meta.vitest name="observability: log the cause"
import { Cause, Effect, Option, Schema, Stream } from "effect"

import { Graft } from "@graftland/graft"

class SyncFailed extends Schema.TaggedError<
	SyncFailed,
	{ readonly brand: unique symbol }
>()("SyncFailed", {}) {}

const sync = Effect.fail(SyncFailed.make())

const synced = Effect.catchTag(sync, "SyncFailed", (error) =>
	Effect.logWarning(
		"Sync failed; serving the last snapshot",
		Cause.fail(error),
	),
)

const cause = await Effect.runPromise(
	Effect.gen(function* () {
		yield* synced
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.cause)
	}).pipe(Effect.provide(Graft.layer)),
)
cause // => Option.some(Cause.fail(SyncFailed.make()))
```

| 情形                                            | 做法                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 恢复后继续运行。                                | 在恢复的地方以 `Warn` 或 `Error` 记录 cause。                                                   |
| 失败会传到 `apply` 或某个 `Plugin.fork` 任务。  | 不要记录。Graft 会连同完整的 cause 记录它，并保留在 `Failed` 状态中。                           |
| 有意放弃尽力而为的工作。                        | `Effect.ignore({ log: "Warn", message: "Refreshing the cache failed" })` 会记录日志并继续执行。 |
| 用 `Effect.tapCause` 记录，同时让失败继续传播。 | 同一个失败会被记录两次。二者只选其一。                                                          |

是否应该恢复，见[插件中的 Effect](../effect/)。

### Graft 记录的日志

可以搜索这些消息，或针对它们设置告警。纯中断属于正常取消，不会产生其中任何一条。

| 消息                                                                          | 级别    | 何时出现                                                                                                 |
| ----------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `Plugin "<name>" failed`                                                      | `Error` | `apply` 失败。每次重试失败都会再记录一次。                                                               |
| `The plugin's background task failed`                                         | `Error` | 某个 [`Plugin.fork` 任务](../../plugins/#任务失败时)失败。                                               |
| `Releasing the plugin's resources failed`                                     | `Error` | fork 停止时某个终结器失败。                                                                              |
| `Updating in place failed; restarting instead`                                | `Warn`  | 插件的[原地更新](../../plugins/#原地更新)失败，fork 改为重启。                                           |
| `The plugin's retry schedule failed`                                          | `Error` | `retry` 调度本身失败。                                                                                   |
| `Still waiting for consumers of <keys>; a teardown cycle may be holding them` | `Warn`  | 撤回服务时仍在等待消费者停止。见[停止迟迟不结束](../troubleshooting/#停止迟迟不结束)。                   |
| `Disposing a loader entry failed`                                             | `Error` | [移除或替换配置项时清理](../../config-file/#清理失败)失败。附带 `loader.entry` 和 `loader.plugin` 注解。 |

## 注解

`graft.fork` 是 fork 的 `id`，与 fork 树中的编号相同；`graft.plugin` 是插件的
`name`。一行日志标注的是哪个 fork，取决于运行这段代码的 fiber：

| 代码                                    | 标注的 fork                                      |
| --------------------------------------- | ------------------------------------------------ |
| `apply`、它的终结器、`Plugin.fork` 任务 | 插件自己的 fork。                                |
| 事件处理函数                            | 注册该处理函数的 fork。                          |
| 服务方法                                | **调用**它的 fork。方法在调用方的 fiber 中运行。 |
| 不属于任何插件的宿主代码                | 无。见[日志](../../lifecycle/#日志)。            |

自己的注解加在对每一行都成立的最小范围上：

| 范围                        | 使用                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| 单个 effect，或整个 `apply` | 在它后面 pipe 上 `Effect.annotateLogs({ ... })`。                                                  |
| 一个 fork 及其下所有插件    | 对 `References.CurrentLogAnnotations` 使用 [`Graft.intercept`](../../intercepts/#修改-reference)。 |
| `graft.yml` 中的一个配置项  | [`effect/References/CurrentLogAnnotations`](../../config-file/#配置文件中的-intercept)。           |

- 键名以你的包名作前缀，就像 Graft 使用 `graft.`、`loader.` 和 `remote.` 一样。
- 要区分服务自身的日志和调用方的日志，就在方法内部添加注解。
- 密钥保持 `Redacted`，直到真正需要它的那次调用。`Redacted` 值在日志中显示为
  `<redacted>`，普通字符串则原样输出。见[类型与密钥](../../config-file/#类型与密钥)。

## 按配置项设置级别

只为正在排查的配置项调低级别。该设置作用于这个配置项及其子插件，兄弟配置项保持各自的级别。

| 目标                       | 设置                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| 查看某个插件的调试日志     | 在该项的 `intercept` 中写 `effect/References/MinimumLogLevel: Debug`。 |
| 让话多的插件安静下来       | 在该项的 `intercept` 中写 `effect/References/MinimumLogLevel: Warn`。  |
| 在 TypeScript 中做同样的事 | 在 `Graft.plugin` 的 `intercept` 选项中使用 `Graft.intercept`。        |

- 修改 `intercept`
  会卸载并重新加载该配置项。见[在运行期间修改配置](../../config-file/#在运行期间修改配置)。
- `graft start` 没有设置全局级别的选项，请在配置项上设置。
- 嵌入 Graft 的宿主需要先[登记这些键](../../intercepts/#配置文件中的-intercept)，YAML 中才能使用它们，做法见[嵌入而不使用 CLI](../production/#嵌入而不使用-cli)。

## 在宿主中选择输出

`graft start`
把[便于阅读的日志行](../../cli/#日志与-intercept)输出到标准错误，没有其他格式。要输出 JSON 行或接入日志采集工具，请[嵌入 Graft](../../embedding/)，并在
`Graft.layer` 下层提供一个 `Logger`
layer；没有提供时，使用 Effect 的默认 logger 输出。

```ts import.meta.vitest name="observability: choose the output"
import { Effect, Layer, Logger, Option, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

const runtime = Layer.provideMerge(
	Graft.layer,
	Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.consoleJson])),
)

const message = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Effect.log("Listening on 8080")
		const entry = yield* Stream.runHead(Graft.logs)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.provide(runtime)),
)
message // => Option.some(["Listening on 8080"])
```

`Graft.layer` 会把自己的收集器加入它在下层找到的 logger 中。如果 `Logger.layer`
提供在更靠近程序的位置，或在 `Layer.mergeAll` 中排在 `Graft.layer`
之后，它就会替换掉这个收集器，`Graft.logs` 将收不到任何内容。

[远程插件](../../remote/overview/)的日志按其自身的级别到达宿主的 logger，插件的注解放在
`remote.annotations` 中，并附带 `remote.pid` 或
`remote.threadId`。高负载下丢失的日志会以
[`Remote logs were dropped`](../../remote/transport-auth/#警告) 报告。

## 在插件中收集日志

`Graft.logs`
是环境中所有日志的流，可用于告警、日志查看界面或测试。基础用法见[日志](../../lifecycle/#日志)。

```ts import.meta.vitest name="observability: collect logs in a plugin"
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	LogLevel,
	Stream,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Pager extends Context.Service<
	Pager,
	{ readonly page: (entry: Graft.LogEntry) => Effect.Effect<void> }
>()("app/Pager") {}

const alerts = Plugin.make({
	name: "app/alerts",
	inject: [Pager],
	apply: () =>
		Effect.gen(function* () {
			const pager = yield* Pager
			const started = yield* Clock.currentTimeMillis
			yield* Graft.logs.pipe(
				Stream.filter(
					(entry) =>
						entry.date.getTime() >= started &&
						LogLevel.isGreaterThanOrEqualTo(entry.level, "Error"),
				),
				Stream.runForEach(pager.page),
				Plugin.fork,
			)
		}),
})

const pages = Deferred.makeUnsafe<Graft.LogEntry>()
const layer = Layer.provideMerge(
	Graft.layer,
	Layer.succeed(Pager, { page: (entry) => Deferred.succeed(pages, entry) }),
)

const paged = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(alerts)
		yield* fork.await
		yield* Effect.log("Order accepted")
		yield* Effect.logError("Payment refused; order dropped")
		const entry = yield* Deferred.await(pages)
		return entry.message
	}).pipe(Effect.scoped, Effect.provide(layer)),
)
paged // => ["Payment refused; order dropped"]
```

| 陷阱       | 规则                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 重放的日志 | 新订阅者会先收到[最近的日志](../../lifecycle/#日志)，因此重启后的插件会再次看到它们。按 `date` 过滤。 |
| 反馈循环   | 你的插件自己写的日志也会到达。不要以你转发的级别记录日志，或者跳过带有你自己 `graft.plugin` 的日志。  |
| 消费过慢   | 缓冲区是滑动的。跟不上的订阅者会丢失最早的日志；记录日志永远不会等待它。                              |

## Span

Graft 在名为 `graft.plugin <name>` 的 span 中解码插件配置并运行它的
`apply`。每次加载、重启和重试都会开启一个新的 span。用 `Effect.fn` 或
`Effect.withSpan` 为你自己的操作命名：

```ts import.meta.vitest name="observability: name your spans"
import { Effect, Option, Schema, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// Stands in for a real connection.
const connect = (url: string) => Effect.logDebug(`Connecting to ${url}`)

const feed = Plugin.make({
	name: "app/feed",
	config: Schema.Struct({ url: Schema.String }),
	apply: Effect.fn("feed.apply")(function* ({ url }) {
		yield* connect(url).pipe(
			Effect.withSpan("feed.connect", { attributes: { url } }),
		)
	}),
})

// Records each span as "parent > name".
const spans: Array<string> = []
const tracer = Tracer.make({
	span: (options) => {
		const parent = Option.getOrUndefined(options.parent)
		spans.push(
			parent?._tag === "Span"
				? `${parent.name} > ${options.name}`
				: options.name,
		)
		return new Tracer.NativeSpan(options)
	},
})

await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(feed, { url: "https://example.com/feed" })
		yield* fork.await
	}).pipe(
		Effect.scoped,
		Effect.withTracer(tracer),
		Effect.provide(Graft.layer),
	),
)
spans // => ["graft.plugin app/feed", "graft.plugin app/feed > feed.apply", "feed.apply > feed.connect"]
```

- `graft.plugin <name>` 位于加载该插件时所在的 span 之下，因此在 `apply`
  中加载的子插件位于父插件的 span 之下。
- `apply` 内部及其 `Plugin.fork` 任务中的 span 都位于 `graft.plugin <name>`
  之下，即使该 span 已在 `apply` 返回时结束。
- 用插件名和操作名为 span 命名，就像示例中的 `Effect.fn("exchange.apply")`。
- 打印出的 cause 会把 span 显示为一帧：`at graft.plugin <name>`。

每个 `graft.plugin <name>` span 都带有该插件日志的身份 `graft.fork` 和
`graft.plugin`，另外还有 `graft.revision`：

| 属性             | 值                                                         |
| ---------------- | ---------------------------------------------------------- |
| `graft.fork`     | fork 的 `id`。                                             |
| `graft.plugin`   | 插件的 `name`。                                            |
| `graft.revision` | 从 0 开始，`restart`、替换和回滚时递增；配置更新不改变它。 |

### 导出 span

`graft start` 会创建 span，但不安装任何 exporter。用
[`@graftland/plugin-otlp`](https://github.com/graftland/graft/tree/main/packages/plugin-otlp)
插件导出它们：这是一个只用公开 Graft API 构建的普通插件。它自己加载 `plugins`
中的配置项，并把这棵子树的 span 发送到 OTLP/HTTP 收集端：

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    url: !env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    serviceName: chat-bot
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| 修改                         | 效果                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP exporter 设置           | 新 span 交给新的 exporter；已开始的 span 留在旧 exporter；这些 span 结束后刷新并关闭旧 exporter。等待最长为旧配置的 `shutdownTimeout`；Effect 随后为刷新单独提供一个 `shutdownTimeout` 时限（总计最长为两倍时限）。子树继续运行。 |
| `exporter.config`            | 转发给 exporter 的更新函数；兼容的更新保持子树运行。                                                                                                                                                                              |
| `plugins`                    | 像分组一样协调：未变化的配置项继续运行。exporter 配置未变时，不调用其更新函数。                                                                                                                                                   |
| `exporter.name`              | 使用新的 provider 重启被追踪的子树。                                                                                                                                                                                              |
| 将配置项移入或移出 `plugins` | 这些配置项会重启，因为父级和 intercept 改变了。                                                                                                                                                                                   |
| Exporter 失败                | 子树等待 `Exporter` 服务；exporter 自身重试成功后，子树恢复运行，无需修改配置。                                                                                                                                                   |
| 卸载该配置项                 | 先停止子树，再并发刷新并关闭所有剩余 exporter。                                                                                                                                                                                   |

`plugins` 之外的插件不会被追踪。Graft 会像处理顶层条目一样，把 `plugins`
中缺失的 id 写回文件，调整顺序时保留身份。

HTTP 字段是普通插件 `@graftland/plugin-otlp/http` 的简写。它支持
`serialization: json | protobuf`、资源属性和批量导出选项；默认值见
[包配置](https://github.com/graftland/graft/tree/main/packages/plugin-otlp#readme)。时长以毫秒计；数值字段接受
`!env` 字符串。HTTP 头以 `Redacted` 保存，凭据通过 `headers` 中的 `!env`
传入。缺少 `HttpClient` 时，HTTP 插件停在 `Pending`。

使用 `exporter` 替代 HTTP 字段，选择第三方实现：

```yaml title="graft.yml"
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    exporter:
      name: graft-plugin-custom-traces
      config:
        destination: !env TRACE_DESTINATION
    plugins:
      - id: bot
        name: ./src/bot.ts
```

| Exporter 契约 | 规则                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服务          | 通过 `Graft.provide` 发布 `@graftland/plugin-otlp/Exporter` 中的稳定 `Tracer.Tracer` 服务 `Exporter`，key 为 `@graftland/plugin-otlp/Exporter`。 |
| 生命周期      | 资源和 fiber 由插件 scope 管理；更新时保留未完成的 span，关闭时刷新，保留失败的 cause。                                                          |
| 更新          | 返回更新函数并保持已发布的 tracer 对象不变。重启会撤回服务并重启使用者。                                                                         |
| 隔离          | 每个宿主隔离 `Exporter`；实现仍可注入应用服务。简写和显式名称都通过 `ModuleResolver` 解析。                                                      |
| 验证          | 为 `Testing.exporter` 提供新的 `Graft.layer` 和收集端；`received` 在关闭后返回已刷新的 span 名称。                                               |

```ts
import { Effect } from "effect"

import type { Plugin } from "@graftland/graft"
import * as Testing from "@graftland/plugin-otlp/Testing"

declare const exporter: Plugin.Plugin
declare const received: Effect.Effect<ReadonlyArray<string>>

const conformance = Testing.exporter({
	plugin: exporter,
	config: { destination: "test" },
	nextConfig: { destination: "updated" },
	received,
})
```

Effect 每棵子树只有一个 tracer，没有 fan-out 组合器；嵌套宿主会覆盖外层 tracer。其他传输、属性增强和厂商 exporter 由第三方实现。本包不提供日志和指标导出；第三方可以实现这些功能。

嵌入 Graft 时，也可以在放置 [`Logger` layer](#在宿主中选择输出)
的位置提供一个tracer layer，例如 `effect/observability` 中的 OTLP exporter：

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

const tracing = OtlpTracer.layer({
	url: "http://localhost:4318/v1/traces",
	resource: { serviceName: "chat-bot" },
}).pipe(
	Layer.provide(
		Layer.mergeAll(OtlpSerialization.layerJson, FetchHttpClient.layer),
	),
)
```

- 每个插件都从加载它的位置继承 tracer，loader 加载的配置项也一样。
- Effect 的默认 logger 会把日志行作为事件附加到当前 span 上。`Logger.layer`
  会替换这些默认 logger；要保留这一行为，请在其中列出 `Logger.tracerLogger`。
- 远程插件运行在另一个进程或 worker 中，宿主的 tracer 到达不了那里。

## 用 fork 树诊断

日志记录发生过什么；[`Graft.forks`](../../lifecycle/#fork-树) 显示现在的状态。在
`Pending` 中等待的 fork 不会写日志，因此请把停留在该状态的 fork 记录下来：

```ts import.meta.vitest name="observability: log the forks that wait"
import { Array, Context, Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const unhealthy = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(tree.state._tag === "Failed" || tree.state._tag === "Pending"
			? [`${tree.name}: ${tree.state._tag}`]
			: []),
		...unhealthy(tree.children),
	])

const waiting = Plugin.make({
	name: "app/waiting",
	apply: () =>
		Graft.forks.pipe(
			Stream.debounce("5 seconds"),
			Stream.map(unhealthy),
			Stream.runForEach((forks) =>
				forks.length === 0
					? Effect.void
					: Effect.logWarning("Forks not running", forks),
			),
			Plugin.fork,
			Effect.asVoid,
		),
})

class Database extends Context.Service<Database, {}>()("app/Database") {}

const reports = Plugin.make({
	name: "app/reports",
	inject: [Database],
	apply: () => Effect.void,
})

const warning = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(waiting)
		yield* Graft.plugin(reports)
		const entry = yield* Stream.runHead(
			Stream.filter(Graft.logs, (entry) => entry.level === "Warn"),
		)
		return Option.map(entry, (entry) => entry.message)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
warning // => Option.some(["Forks not running", ["app/reports: Pending"]])
```

- `unhealthy`
  是[报告健康状态](../production/#报告健康状态)中的遍历函数，它列出处于
  `Pending` 或 `Failed` 的 fork。
- 对流做防抖：每次变化它都会发出，配置项加载期间会发出很多次。
- `Failed` 节点的 `cause` 包含 Graft 为它记录过的失败。
- 症状及其原因见[故障排查](../troubleshooting/)。
