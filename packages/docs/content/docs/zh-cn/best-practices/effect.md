---
title: 插件中的 Effect
description:
  让插件代码以 Graft 能够停止和清理的方式获取资源、失败、重试和运行工作。
---

在 `apply`
内部，插件就是普通的 Effect 代码，Graft 只管理包在外面的 fork。只要所有资源、fiber 和失败都留在这个 fork 内，Graft 就能停止、重试和替换插件，而不会泄漏任何东西。

## 导入时只描述，在 `apply` 中获取

插件模块只定义值。凡是打开、启动或读取外部世界的操作，都放在 `apply`
中执行，由 fork 的 `Scope`
持有。在导入时打开的连接池永远不会关闭，而且每次重载都会再打开一个：

```ts skip
const pool = createPool(process.env.DATABASE_URL)
```

改在 `apply` 中打开，fork 启动时打开、停止时关闭：

```ts
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Pool {
	readonly end: () => Promise<void>
}
declare const createPool: (url: string) => Pool

class Database extends Context.Service<Database, Pool>()("app/Database") {}

export default Plugin.make({
	name: "app/database",
	config: Schema.Struct({ url: Schema.String }),
	apply: ({ url }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				Effect.sync(() => createPool(url)),
				(pool) => Effect.promise(() => pool.end()),
			)
			yield* Graft.provide(Database, pool)
		}),
})
```

服务键、事件令牌、schema、错误类型和插件本身放在模块顶层；其余规则见[插件模块的规则](../../plugins/#插件模块)。从配置字段读取设置，而不是从
`process.env` 读取，见[设置放在哪里](../design/#设置放在哪里)。

## 释放资源

按资源需要存活多久选择工具：

| 资源存活于……                       | 使用                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| 与 fork 同寿，且有关闭操作         | `Effect.acquireRelease(open, close)`                                     |
| 与 fork 同寿，只有一个停止步骤     | `Effect.addFinalizer((exit) => ...)`                                     |
| 一项工作期间（一个请求、一批数据） | 在这项工作外包一层 `Effect.scoped`，或使用 `Effect.acquireUseRelease`    |
| 一次处理函数调用期间               | 在处理函数中获取。见[处理函数的上下文](../../events/#处理函数的上下文)。 |
| 一个后台任务期间                   | 在任务内部获取。见[后台任务](../../plugins/#后台任务)。                  |

- **在 `acquireRelease` 内部打开，而不是在它之前。**
  打开步骤不会被中断到一半，一旦成功，关闭操作就已登记。
- **关闭出错就让它成为 defect。**
  吞掉问题的关闭操作会掩盖泄漏；Graft 会把清理产生的 defect 保留在 `Cause` 中。

## 包装 promise 和回调

按 reject 意味着什么选择构造函数：

| 这段代码……                     | 使用                                | 失败变成             |
| ------------------------------ | ----------------------------------- | -------------------- |
| 正常运行时也可能 reject（I/O） | `Effect.tryPromise({ try, catch })` | 你的带标签错误       |
| 只有出 bug 时才会 reject       | `Effect.promise`                    | defect               |
| 正常运行时可能同步抛出异常     | `Effect.try({ try, catch })`        | 你的带标签错误       |
| 用回调而不是 promise 返回结果  | `Effect.callback`                   | 你传给 `resume` 的值 |

```ts title="forecast.ts"
import { Effect, Schema } from "effect"

// A promise-based client library; this one is always offline.
const weatherApi = {
	today: (city: string, options: { signal: AbortSignal }): Promise<string> =>
		Promise.reject(new Error(`No route to the weather service for ${city}`)),
}

export class ForecastFailed extends Schema.TaggedError<
	ForecastFailed,
	{ readonly brand: unique symbol }
>()("ForecastFailed", { city: Schema.String, cause: Schema.Defect() }) {}

export const today = (city: string) =>
	Effect.tryPromise({
		try: (signal) => weatherApi.today(city, { signal }),
		catch: (cause) => ForecastFailed.make({ city, cause }),
	})
```

- **把 `signal` 传下去。**
  fiber 被中断时（例如 fork 停止时），Effect 会 abort 它。忽略它的 promise 会在 fork 消失后继续运行。
- **给 `catch` 一个带标签的错误。** 没有 `catch` 时，`Effect.tryPromise` 以
  `UnknownError` 失败，调用方无从得知是什么失败了。把原始错误保留在 `cause` 中。

## 预期失败与 defect

调用方能够应对的失败是**预期失败**：effect 错误类型中的一个**带标签的错误**（tagged
error）。表示代码本身有错的失败是 **defect**。

| 情形                             | 处理为                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| 未找到、不可用、被限流、输入无效 | 一个带标签的错误类，例如 `Schema.TaggedError`                 |
| 调用方应当处理的库错误           | 你自己的带标签错误，把库错误放进 `cause`                      |
| 不变量被破坏、本不可能走到的分支 | defect：`Effect.die`，或对无人能处理的错误使用 `Effect.orDie` |

错误类型是服务或事件契约的一部分：保持精确，不要写成
`unknown`。任务的错误会并入插件的类型，见[类型中的任务错误](../../plugins/#类型中的任务错误)。

## 在能采取行动的地方恢复

在能对错误采取行动的地方捕获它，其余的让它继续向上传：

```ts import.meta.vitest name="best-practices/effect: recover where you can act"
import { Cause, Effect } from "effect"

import { today } from "./forecast.ts"

const answer = (city: string) =>
	Effect.catchTag(today(city), "ForecastFailed", (error) =>
		Effect.as(
			Effect.logWarning("Forecast lookup failed", Cause.fail(error)),
			"Weather is unavailable right now.",
		),
	)

await Effect.runPromise(answer("Oslo")) // => "Weather is unavailable right now."
```

| 失败发生在                            | 恢复方式                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| 需要答复某人的调用（处理函数、请求）  | 像上例那样用兜底值答复                                                             |
| 后台循环的某一轮                      | 在任务内部、传给 `Plugin.fork` 之前捕获；见[任务失败时](../../plugins/#任务失败时) |
| 重复执行就可能成功的调用              | `Effect.retry`；见[让 fork 失败并重试](#让-fork-失败并重试)                        |
| fork 自身的状态（连接断开、配置有误） | 不捕获，让 fork 失败                                                               |

| 规则                                                         | 避免的问题                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 用 `Effect.catchTag` 按标签捕获。                            | 其他错误留在类型中，调用方看得见，不会被意外处理掉。                                            |
| 记录 `Cause`，而不是 `error.message`。                       | 日志保留错误的字段、调用栈以及同时发生的 defect。见[记录 Cause](../observability/#记录-cause)。 |
| 不要为了让坏掉的部分继续运行而忽略错误，或记一条日志就继续。 | fork 保持 `Active`，却什么也不做。失败的 fork 看得见、会被清理，也可以重试。                    |
| 不要用 `Effect.catchCause` 捕获 defect 来维持运行。          | defect 就是 bug；从中恢复，只会让 bug 在已损坏的状态上继续运行。                                |

## 让 fork 失败并重试

`apply`
或任务中的失败会[使 fork 失败](../../plugins/#失败与重试)。在重试单次调用和重试整个 fork 之间做选择：

|        | 包在调用外的 `Effect.retry` | 插件的 `retry` 选项                         |
| ------ | --------------------------- | ------------------------------------------- |
| 重复   | 一次操作                    | 整个 `apply`，资源和任务都重新创建          |
| 状态   | 保留                        | 释放；下一次尝试从干净状态开始              |
| 消费者 | 察觉不到                    | 服务被撤回；消费者重启或在 `Pending` 中等待 |

```ts
import { Effect, Schedule, Scope } from "effect"

import { Plugin } from "@graftland/graft"

interface Session {
	readonly next: Effect.Effect<string, Error>
}
declare const connect: Effect.Effect<Session, Error, Scope.Scope>
declare const publish: (item: string) => Effect.Effect<void>

const feed = Plugin.make({
	name: "app/feed",
	retry: Schedule.spaced("10 seconds"),
	apply: () =>
		Effect.gen(function* () {
			const session = yield* connect
			yield* session.next.pipe(
				Effect.retry({ times: 3, schedule: Schedule.spaced("200 millis") }),
				Effect.flatMap(publish),
				Effect.forever,
				Plugin.fork,
			)
		}),
})
```

读取失败时在同一个会话上重试；`connect`
失败，或读取一再失败，则 fork 失败，并按插件的调度重新连接。

- 不要用 `retry` 等待服务；`inject` 会让 fork 停在 `Pending`。
- 插件调度的选法见[重试不稳定的资源](../production/#重试不稳定的资源)。

## 后台工作与并发

每个 fiber 都需要一个所有者，由它结束 fiber、看到 fiber 失败；在插件中，这个所有者就是 fork。

| 需求                                 | 使用                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| 在 fork 运行期间持续运行的循环或监听 | `Plugin.fork`                                                                     |
| 同时执行几个步骤，并等待全部完成     | 带 `concurrency` 的 `Effect.all` 或 `Effect.forEach`                              |
| 一串值                               | 一个 `Stream`，在 `Plugin.fork` 任务中消费                                        |
| 由调用方交给单个 worker 的工作       | 在 `apply` 中创建的 `Queue`，由一个 `Plugin.fork` 任务取出处理                    |
| 广播给每个订阅者的值                 | 在 `apply` 中创建的 `PubSub`，用 `PubSub.shutdown` 关闭                           |
| fork 的任务与服务共享的状态          | 在 `apply` 中创建的 `Ref`                                                         |
| 按 ID 区分、相互替换的任务           | 在 `apply` 中创建的 `FiberMap`，并用 `Plugin.fork(FiberMap.join(map))` 暴露其失败 |

```ts
import { Context, Effect, Queue } from "effect"

import { Graft, Plugin } from "@graftland/graft"

interface Mail {
	readonly to: string
	readonly text: string
}
declare const deliver: (mail: Mail) => Effect.Effect<void, Error>

class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (mail: Mail) => Effect.Effect<void> }
>()("app/Mailer") {}

const mailer = Plugin.make({
	name: "app/mailer",
	apply: () =>
		Effect.gen(function* () {
			const outbox = yield* Queue.bounded<Mail>(100)
			yield* Queue.take(outbox).pipe(
				Effect.flatMap(deliver),
				Effect.forever,
				Plugin.fork,
			)
			yield* Graft.provide(Mailer, {
				send: (mail) => Effect.asVoid(Queue.offer(outbox, mail)),
			})
		}),
})
```

`send`
的调用方只负责入队。投递在 mailer 自己的任务中运行：它随 mailer 一起停止，它的失败让 mailer 失败，而不是让调用方失败。

| 避免                                                       | 原因                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Effect.forkChild`                                         | `apply` 一返回 fiber 就被中断，而中断不会让插件失败，工作就这样悄无声息地停了。              |
| `Effect.forkScoped`、`Effect.forkDetach`、`Effect.runFork` | Graft 看不到 fiber 失败，后两者还会比 fork 活得更久。见[后台任务](../../plugins/#后台任务)。 |
| 在服务方法中 fork                                          | 方法运行在调用方的 fiber 中。应在 `apply` 中启动 worker，并通过 `Queue` 把工作交给它。       |

## 定时器与时间

原生定时器会比 fork 活得更久、无视中断，也无法由 `TestClock`
驱动（见[控制时间](../testing/#控制时间)）。改用 Effect 中的对应写法：

| 不要用                        | 改用                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `setTimeout(work, ms)`        | `Plugin.fork(Effect.delay(work, ms))`，或在任务内使用 `Effect.sleep` |
| `setInterval(work, ms)`       | `Plugin.fork(Effect.repeat(work, schedule))`，或 `Stream.tick`       |
| 暂停，或保持固定频率          | `Schedule.spaced` 在每次运行后等待；`Schedule.fixed` 保持固定频率    |
| 让 promise 与定时器赛跑       | `Effect.timeout`                                                     |
| `Date.now()`、`Math.random()` | `Clock.currentTimeMillis`、`Random.next`                             |

## 在边界处校验

外部数据在进入时解码一次，内部只传递带类型的值：

| 输入               | 解码方式                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| 插件配置           | `config` schema；见[配置解码](../../plugins/#配置解码)                     |
| 请求体、消息、文件 | `Schema.decodeUnknownEffect(schema)`；在答复发送方的地方捕获 `SchemaError` |
| JSON 文本          | 用 `Schema.fromJsonString(schema)` 代替 `JSON.parse`                       |
| 密钥               | `Schema.RedactedFromValue`；见[类型与密钥](../../config-file/#类型与密钥)  |

在内部保持值不可变：用 `Option` 代替 `null`，用按值比较的 `Data` 类，用放在
`Ref` 中的 `HashMap` 代替可变的 `Map`，数组和字段都标为 `readonly`。

## 依赖写进类型

依赖要写在 effect 的类型中，由编译器检查：

| 需求                 | 满足方式                                                       |
| -------------------- | -------------------------------------------------------------- |
| 另一个插件发布的服务 | `inject`；见[依赖](../../plugins/#依赖)                        |
| 与宿主同寿的服务     | 环境 layer；见[来自环境的服务](../../services/#来自环境的服务) |
| 跟随调用方的设置     | 一个 `Context.Reference` 加上 [intercept](../../intercepts/)   |

- **服务方法不带依赖。** 在 `apply` 中读取依赖并捕获在闭包里，就像 `mailer`
  捕获它的队列那样；留在方法类型中的依赖，每个调用方都必须满足。只有用于[跟随调用方](../../intercepts/#跟随调用者的设置)的
  `Context.Reference` 设置才在方法中读取。
- **不用模块级单例、`any` 或类型断言。** 它们会把编译器要检查的依赖藏起来。
