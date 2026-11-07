---
title: 测试
description:
  用 @effect/vitest 测试插件和整个应用，不用 sleep，测试之间也不共享状态。
---

Graft 测试是一个 Effect，由 `@effect/vitest` 在它独享的运行时上执行。测试用
`Graft.plugin` 加载插件，等待明确的信号，再检查发生了什么，包括插件停止之后。

## 搭建测试

示例测试的是 `welcome`，一个启动时发送一封邮件的插件：

```ts title="welcome.ts"
import { Context, Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export class MailRejected extends Schema.TaggedError<
	MailRejected,
	{ readonly brand: unique symbol }
>()("MailRejected", { to: Schema.String }) {}

export class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (to: string) => Effect.Effect<void, MailRejected> }
>()("app/Mailer") {}

export const welcome = Plugin.make({
	name: "app/welcome",
	config: Schema.Struct({ to: Schema.String }),
	inject: [Mailer],
	retry: Schedule.spaced("1 second"),
	apply: ({ to }) =>
		Effect.gen(function* () {
			const mailer = yield* Mailer
			yield* mailer.send(to)
		}),
})
```

每个测试都经过 `run`，由它为测试提供独享的运行时：

```ts title="run.ts"
import { Effect, Layer, type Scope } from "effect"

import { Graft } from "@graftland/graft"

export const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
```

测试提供插件所需的服务，加载插件，再检查发生了什么：

```ts
import { Array, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("sends one mail on start", () =>
	Effect.gen(function* () {
		const outbox = yield* Ref.make<ReadonlyArray<string>>([])
		yield* Graft.provide(Mailer, {
			send: (to) => Ref.update(outbox, Array.append(to)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* fork.await
		const sent = yield* Ref.get(outbox)
		assert.deepStrictEqual(sent, ["alice@example.com"])
	}).pipe(run),
)
```

| 部分                                       | 原因                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `Layer.fresh(Graft.layer)`                 | 即使 layer 会被记忆化，也构建一个新的运行时，因此服务、fork ID 和日志不会从一个测试泄漏到另一个测试。                      |
| `Effect.scoped`                            | 卸载测试加载的所有插件。清理失败会作为 defect 抛出，使测试失败。                                                           |
| `it.effect`                                | 运行在 `TestClock` 上：只有测试推动时，时间才会前进。见[控制时间](#控制时间)。                                             |
| `it.live`                                  | 使用真实时钟，适用于真实的服务器、子进程和 worker。                                                                        |
| [环境服务](../../services/#来自环境的服务) | `Layer.provideMerge(Layer.fresh(Graft.layer), NodeServices.layer)`。测试体同样能看到它们，它们也不会让插件停在 `Pending`。 |
| 测试数据                                   | 在测试内部创建 `Ref`、`Deferred` 和假实现。模块级的值会被所有测试共享。                                                    |

这里的 `Mailer` 是一个**假实现**（fake）：它把调用记录到 `Ref`
中，失败时返回真实服务声明的类型化错误，例如 `MailRejected.make({ to })`。

| 发布假实现的方式                                         | 适用场景                                     |
| -------------------------------------------------------- | -------------------------------------------- |
| 在测试体中调用 `Graft.provide`                           | 在整个测试期间保持发布，运行时关闭时撤回。   |
| `Plugin.service(Mailer, Effect.succeed(fake), { name })` | 测试要卸载或替换它，以观察消费者停止并等待。 |
| 环境                                                     | 真实服务也来自环境。                         |

## 等待状态

下面的辅助函数等待 fork 第一次到达指定的[状态](../../lifecycle/#fork-状态)。其他等待方式见
[`await`、`stable` 和 `state`](../../fork-handle/#awaitstable-和-state)。

```ts title="reach.ts"
import { Effect, Stream } from "effect"

import type { Fork } from "@graftland/graft"

export const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap((state) => Effect.fromOption(state)),
	)
```

| 误区                                                                                 | 改为                                                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 以为 `fork.await` 之后就是 `Active`。它在 `Pending` 时也会返回，即使发布方刚刚加载。 | 断言状态，或使用 `reach(fork, "Active")`。                        |
| 用 sleep 或循环调用 `Effect.yieldNow` 等待某件事发生。                               | 等待状态、[`Deferred`](#用-deferred-协调) 或 `loader.ready`。     |
| 在发布方 `dispose` 之后立即断言消费者处于 `Pending`。                                | `dispose` 在消费者停止后就会返回。使用 `reach(fork, "Pending")`。 |

## 断言失败

返回类型化错误的假实现会让 `welcome` 失败。

| 要检查                       | 使用                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| 类型化错误                   | `Effect.flip(fork.await)`。defect 不会被翻转，它会直接让测试失败。                |
| defect，或同时发生的多个失败 | `Effect.exit(fork.await)`，然后读取 `Cause`。                                     |
| fork 保留的失败              | `reach(fork, "Failed")`，然后读取它的 `cause`。                                   |
| 无法解码的配置               | `Effect.flip(fork.await)` 得到 `SchemaError`。                                    |
| 卸载时的失败                 | `Effect.flip(fork.dispose)` 得到 `Fork.CleanupError`，它的 `cause` 保留原始失败。 |

## 记录发生了什么

**记录簿**（journal）是一个
`Ref`，插件向其中追加事件。要检查停止带来了什么，先关闭一个内层scope，再在它之后断言；此时运行时仍然开着：

```ts
import { Array, Effect, Ref, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

it.effect("restarts on a new config", () =>
	Effect.gen(function* () {
		const journal = yield* Ref.make<ReadonlyArray<string>>([])
		const record = (event: string) => Ref.update(journal, Array.append(event))
		const echo = Plugin.make({
			name: "app/echo",
			config: Schema.Struct({ text: Schema.String }),
			apply: ({ text }) =>
				Effect.acquireRelease(record(`start ${text}`), () =>
					record(`stop ${text}`),
				),
		})
		yield* Effect.scoped(
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(echo, { text: "a" })
				yield* fork.await
				yield* fork.update({ text: "b" })
				yield* fork.await
			}),
		)
		const entries = yield* Ref.get(journal)
		assert.deepStrictEqual(entries, ["start a", "stop a", "start b", "stop b"])
	}).pipe(run),
)
```

- `fork.update` 和 `fork.restart`
  不会等待[重启](../../fork-handle/#update-和-restart)完成。下一次 `fork.await`
  才会等待新的 activation。
- [原地更新](../../plugins/#原地更新)的插件接受变更时，不会记录停止和启动。要断言的正是这个差别。
- 有多个插件时，先等前一个加载完成再加载下一个，否则它们的启动顺序不固定。停止顺序遵循[归属与停止顺序](../../lifecycle/#归属与停止顺序)。

## 控制时间

`it.effect` 会安装来自 `effect/testing` 的 `TestClock`。`TestClock.adjust`
会立即运行定时器和重试调度：

```ts
import { Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, MailRejected, welcome } from "./welcome.ts"

it.effect("retries until the mail goes out", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		yield* Graft.provide(Mailer, {
			send: (to) =>
				Effect.flatMap(
					Ref.updateAndGet(attempts, (n) => n + 1),
					(n) => (n < 3 ? MailRejected.make({ to }) : Effect.void),
				),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		const error = yield* Effect.flip(fork.await)
		assert.strictEqual(error._tag, "MailRejected")
		yield* TestClock.adjust("2 seconds")
		yield* reach(fork, "Active")
		const count = yield* Ref.get(attempts)
		assert.strictEqual(count, 3)
	}).pipe(run),
)
```

- 先让代码运行到它开始 sleep 的地方，再调整时钟；这里是第一次失败。调整之后才开始的 sleep 从新的时间算起。
- 一次 `adjust`
  会按顺序运行所有到期的 sleep，包括被唤醒的 fiber 新开始的 sleep。
- 出现警告 `A test is using time, but is not advancing the test clock`
  说明代码在等待时钟。推进时钟，或者对真实 I/O 改用 `it.live`。

## 用 Deferred 协调

要让插件停在某个点上，就给它两个
`Deferred`：一个用来发信号，另一个用来等待。插件停在关卡（gate）前时，测试可以检查、更新、重启或卸载它，也可以撤回它使用的服务：

```ts
import { Deferred, Effect, Option, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { reach } from "./reach.ts"
import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

it.effect("is Loading while the mail is sent", () =>
	Effect.gen(function* () {
		const sending = yield* Deferred.make<void>()
		const gate = yield* Deferred.make<void>()
		const signal = Deferred.succeed(sending, undefined)
		yield* Graft.provide(Mailer, {
			send: () => Effect.andThen(signal, Deferred.await(gate)),
		})
		const fork = yield* Graft.plugin(welcome, { to: "alice@example.com" })
		yield* Deferred.await(sending)
		const current = yield* Stream.runHead(fork.state)
		assert.strictEqual(Option.getOrThrow(current)._tag, "Loading")
		yield* Deferred.succeed(gate, undefined)
		yield* reach(fork, "Active")
	}).pipe(run),
)
```

## 收集日志

`Graft.logs`
先重放最近的日志，然后保持打开。先记录一条标记，再读到这条标记为止：

```ts import.meta.vitest name="testing: collect logs"
import { Array, Effect, Equal, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { run } from "./run.ts"

const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) =>
			Equal.equals(entry.message, ["end of log"]),
		),
	)
	return Array.map(Array.dropRight(entries, 1), (entry) => entry.message)
})

const greeter = Plugin.make({
	name: "app/greeter",
	apply: () => Effect.log("hello"),
})

await Effect.runPromise(
	run(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter)
			yield* fork.await
			return yield* messages
		}),
	),
) // => [["hello"]]
```

| 规则     | 说明                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 历史     | 新订阅者只能收到[最近的日志](../../lifecycle/#日志)。在较长的测试中，对过滤后的日志行做断言。                            |
| 插件失败 | 以 `Error` 级别记录，完整的 `Cause` 位于 `cause` 中。具体消息见 [Graft 记录的日志](../observability/#graft-记录的日志)。 |
| 并发     | 并发插件的日志行会交错。按某个插件的 `graft.plugin` 注解过滤，或断言某个序列按顺序出现。                                 |

## 测试配置项

`Loader.plugin` 运行保存在内存中的配置项，`ModuleResolver.fromRecord`
把配置项的名称解析为插件，因此不需要任何文件：

```ts
import { Deferred, Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import { run } from "./run.ts"
import { Mailer, welcome } from "./welcome.ts"

const resolver = ModuleResolver.fromRecord({ welcome })

it.effect("loads welcome from an entry", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<string>()
		yield* Graft.provide(Mailer, {
			send: (to) => Effect.asVoid(Deferred.succeed(sent, to)),
		})
		yield* Graft.plugin(Loader.plugin, [
			{ id: "welcome", name: "welcome", config: { to: "alice@example.com" } },
		])
		const to = yield* Deferred.await(sent)
		assert.strictEqual(to, "alice@example.com")
	}).pipe(run, Effect.provide(resolver)),
)
```

| 规则      | 说明                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称      | `fromRecord` 按配置项的 `name` 精确查找，不应用[命名约定](../../config-file/#插件名称)。未知名称以 `ModuleNotFound` 失败。                    |
| `Loader`  | 该服务发布在注册表中，而不是环境中。要编辑配置项或调用 `loader.ready`，在一个探针插件中注入 `Loader.Loader`，再通过 `Deferred` 把它交给测试。 |
| 等待      | 编辑在保存后即返回，此时插件还没有变化。断言前先调用 `loader.ready`，见[编辑提供的保证](../../loader-api/#编辑提供的保证)。                   |
| `!env`    | 在文件中会写 `!env` 的位置写 `new Entry.Env({ name })`，并用 `ConfigProvider.fromEnvRecord` 提供变量。                                        |
| YAML 文件 | 加载 `Include.Include`，指向写入 `fs.makeTempDirectoryScoped()` 的 `graft.yml`，并在环境中加入 `NodeServices.layer`。                         |

## 测试远程插件

[远程插件](../../remote/overview/)的实现就是普通插件：像上文那样在进程内测试即可。[06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote/test)示例的测试跨越了边界：`globalSetup`
先把它构建为供 Node 导入的 JavaScript，再由 `it.live` 测试在 `local` 和 `worker`
上运行它。

## 测试安装后的集成

分别打包契约和实现，把 tarball 安装到隔离的消费者项目，再针对公开导出编译和运行。不使用工作区源码别名或私有导入。

| 检查              | 证据                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| 正常升级          | 上游只登录一次，会话和激活次数不变，响应更新，旧单元退出，结果为 `Accepted`。 |
| probe 失败        | `Aborted` 携带 probe 的 cause；旧实现继续服务。                               |
| 试运行和恢复失败  | `Recovered` 或 `RecoveryFailed`，上游会话保留。                               |
| 切换期间的调用    | 已接纳的慢调用返回旧实现的响应。                                              |
| 重复升级          | 每个已退役执行单元都有退出证据。                                              |
| Loader 编辑被拒绝 | 文件和已接受目标均不改变。                                                    |

两种直连部署方式都要运行。
[integration-gateway 示例](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
使用本地 WebSocket 机器人服务器，并从安装后的消费者项目测试 `graft start`。
