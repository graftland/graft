---
title: 设计应用
description: 按归属和生命周期，把问题拆分为插件、服务、事件、领域和各类设置。
---

当 Graft 应用的结构与它的**生命周期**一致时，应用就容易修改。生命周期指能够独立启动、停止、变更、失败或被替换的部分。先找出这些部分，为每个部分确定归属，API 调用自然随之确定。

## 把每个部分对应到构建单元

对功能清单中的每个部分问以下问题：

| 如果这个部分……                                 | 就把它做成                                | 阅读                                   |
| ---------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| 可以单独启用、停用、重新配置或替换             | 一个**插件**，即 `graft.yml` 中的一个条目 | [插件](../../plugins/)                 |
| 提供供其他部分调用的能力                       | 由所属插件发布的**服务**                  | [服务](../../services/)                |
| 离开另一个部分就完全无法工作                   | `inject` 中的必需键                       | [依赖](../../plugins/#依赖)            |
| 有另一个部分时工作得更好，没有时也能工作       | `inject` 中的 `Plugin.optional`           | [依赖](../../plugins/#依赖)            |
| 宣告某件事，任意数量的部分都可能响应           | 一个**事件**                              | [事件](../../events/)                  |
| 每个租户需要自己的服务实例或自己的处理函数     | 一个**领域**，使用 `isolate`              | [领域](../../isolation/)               |
| 是共享服务从调用者处读取的设置                 | `Context.Reference` 上的 **intercept**    | [Intercept](../../intercepts/)         |
| 与进程同寿，且无人配置                         | 由宿主提供的**环境服务**                  | [服务](../../services/#来自环境的服务) |
| 是运维人员选定的值                             | 插件配置 schema 中的一个字段              | [配置文件](../../config-file/)         |
| 必须单独崩溃、使用独立线程或运行在另一台机器上 | 仍然是插件，只是它的条目使用 Remote       | [Remote](../../remote/overview/)       |

只构建一个服务或包装现有 `Layer` 的部分仍然是插件，用
[`Plugin.service` 或 `Plugin.layer`](../../plugins/#从服务和-layer-创建插件)
编写即可。

### 服务还是事件

| 问题             | 服务                                                         | 事件                                           |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| 由多少个部分提供 | 每个领域中每个键一个。第二个发布者会得到 `ServiceConflict`。 | 任意数量的处理函数，也可以一个都没有。         |
| 必须先存在吗     | 是。必需键会让调用方停在 `Pending`。                         | 否。派发只会到达已存在的处理函数，没有也无妨。 |
| 典型用途         | 连接、存储、客户端。                                         | 通知、贡献项、过滤器链。                       |

当许多插件贡献同一类东西（命令、路由、菜单项）时，请使用事件。带 `register`
方法的服务会让每个调用方都得记着调用 `unregister`。

贡献的类型决定使用哪个[派发函数](../../events/#派发事件)：

| 处理函数……                           | 派发方式                                                             |
| ------------------------------------ | -------------------------------------------------------------------- |
| 只需要得知这件事                     | `Event.emit`                                                         |
| 各自为同一个结果添上一部分（帮助行） | `Event.parallel`                                                     |
| 认得输入时才作答（命令）             | `Event.bail`                                                         |
| 包裹、修改或拦下一个值（过滤器）     | 在 [`Event.middleware`](../../events/#中间件) 上用 `Event.waterfall` |

## 状态放在哪里

状态归创建它的 fork 所有，在 `apply`
内创建。其他 fork 只能通过该 fork 的服务或事件访问它：

```ts import.meta.vitest name="best-practices/design: where state lives"
import { Context, Effect, Ref, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Visits extends Context.Service<
	Visits,
	{ readonly count: Effect.Effect<number>; readonly add: Effect.Effect<void> }
>()("@acme/graft-plugin-visits/Visits") {}

const visits = Plugin.make({
	name: "app/visits",
	apply: () =>
		Effect.gen(function* () {
			const count = yield* Ref.make(0)
			yield* Graft.provide(Visits, {
				count: Ref.get(count),
				add: Ref.update(count, (n) => n + 1),
			})
		}),
})

const visitor = Plugin.make({
	name: "app/visitor",
	inject: [Visits],
	apply: () =>
		Effect.gen(function* () {
			const visits = yield* Visits
			yield* visits.add
			const count = yield* visits.count
			yield* Effect.log(`Visit ${count}`)
		}),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(visits)
		yield* (yield* Graft.plugin(visitor)).await
		yield* (yield* Graft.plugin(visitor)).await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Visit 1"], ["Visit 2"]]
```

| 规则                                    | 原因                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 在 `apply` 中创建状态，而不是在模块顶层 | 模块级的值由该插件在所有领域中的所有 fork 共享，fork 停止时也没有任何东西释放它。                            |
| 预期重启会从干净状态开始                | 重启会在新的 `Scope` 中再次运行 `apply`。要在配置变化后保留状态，请返回[更新函数](../../plugins/#原地更新)。 |
| 把持久状态放在插件之后                  | 必须比进程活得更久的数据，应存放在由插件在 `apply` 中打开、在终结器中刷写的存储里。                          |
| 预期 Remote 插件在配置变化时丢失状态    | 它[从不原地更新](../../plugins/#原地更新)。                                                                  |

## 用归属取代手工登记

每个处理函数、服务、资源和子 fork 都归创建它的 Scope 所有，因此插件系统通常需要的那些代码都不必再写：

| 手写做法                       | 在 Graft 中                                                                              | 手写时会出什么问题                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 中央注册表加注销调用           | 在 `apply` 中调用 `Event.on` 或 `Graft.provide`                                          | 漏掉一次注销，就会留下调用已关闭部分的处理函数。 |
| 使用可选部分前先 `if (client)` | `inject: [Client]`，或 `Plugin.optional(Client)`                                         | 检查通过了，客户端却在调用中途消失。             |
| 启动顺序列表                   | 每个插件等待它注入的东西                                                                 | 运维人员新增或停用条目时，列表就失效了。         |
| 模块级单例                     | 由插件发布的服务，或环境服务                                                             | 它无法被替换、隔离或释放。                       |
| 代码中的功能开关               | 条目上的 `disabled: true`                                                                | 被关闭的功能仍然占着资源。                       |
| 重启进程以重新配置             | 条目上的新 `config`；[只有该条目](../../config-file/#在运行期间修改配置)会更新或重新加载 | 其他所有部分也跟着重启。                         |
| 与已加载内容保持同步的列表     | 每个功能都处理的事件，按需收集                                                           | 功能失败或被卸载时，列表就会与实际脱节。         |

只为记一条日志就捕获错误然后继续执行，会让坏掉的部分继续运行。请在能采取行动的地方恢复，或者让 fork 失败并重试，见
[插件中的 Effect](../effect/)。

一次注册多样东西的辅助函数（例如同时注册命令及其帮助行）无需自行清理：在 `apply`
中调用时，它注册的一切都归调用方的 fork 所有。

## 划分插件粒度

一个插件就是一个生命周期。按“哪些东西一起变化”来拆分。

| 过大                                                                                          | 过小                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 一次配置变化会重启所有部分，除非有更新函数来应用它。                                          | 一个生命周期被分散到总是一起加载的多个条目中。       |
| 一个失败的[后台任务](../../plugins/#任务失败时)会使整个 activation 失败，无关部分也随之停止。 | 共享私有状态的部分必须把状态发布为服务才能互相访问。 |
| 运维人员无法单独关闭某个部分。                                                                | 每一次交互都需要一个公开的令牌。                     |

如果命令会独立变化，就把客户端和使用它的命令做成两个插件：重新配置或停用某个命令时，客户端的连接保持打开。命令注入客户端的服务，并在它消失之前停止。

### 分组条目还是组合插件

两者都把多个插件作为一个整体加载，区别在于由谁选择成员：

```ts import.meta.vitest name="best-practices/design: group entry or composing plugin"
import { Effect, Option, Schema, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

const notes = Plugin.make({ name: "app/notes", apply: () => Effect.void })
const storage = Plugin.make({
	name: "app/storage",
	config: Schema.Struct({ file: Schema.String }),
	apply: () => Effect.void,
})

const tenant = Plugin.make({
	name: "app/tenant",
	config: Schema.Struct({ file: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			yield* Graft.plugin(notes)
			yield* Graft.plugin(storage, config)
		}),
})

const trees = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(tenant, { file: "acorn.json" })).stable
		return yield* Stream.runHead(Graft.forks)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
trees // => Option.some([{ id: 1, name: "app/tenant", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [{ id: 2, name: "app/notes", input: undefined, state: Fork.ForkState.Active(), children: [] }, { id: 3, name: "app/storage", input: { file: "acorn.json" }, state: Fork.ForkState.Active(), children: [] }] }])
```

```yaml title="graft.yml"
- id: acorn
  name: acorn
  group: true
  isolate:
    "@acme/graft-plugin-notes/NoteStore": true
  config:
    - name: "@acme/graft-plugin-notes"
    - name: "@acme/graft-plugin-storage"
      config:
        file: acorn.json
```

|                        | 组合插件                                               | 分组条目                                                            |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 成员由谁选择           | 插件作者，在 `apply` 中                                | 运维人员，在 `graft.yml` 中                                         |
| 修改一个成员           | 新配置会重启父插件和所有子插件，除非有更新函数来应用它 | [只有该条目](../../config-file/#在运行期间修改配置)会更新或重新加载 |
| `isolate`、`intercept` | `Graft.plugin` 的选项，可由配置计算得出                | 条目字段                                                            |
| 适用场景               | 成员固定：每个租户都运行这两个插件                     | 成员因部署而异                                                      |

## 设置放在哪里

按谁来设置这个值、它存活多久来选择：

| 设置                                            | 设置者           | 存活时长 | 放在                                                                                       |
| ----------------------------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| 某个插件的一个值：端口、词表、API 密钥          | 运维人员         | 条目     | 配置字段。密钥使用 [`Schema.RedactedFromValue`](../../config-file/#类型与密钥) 和 `!env`。 |
| 所有插件都可能用到的能力：文件系统、HTTP 客户端 | 宿主的作者       | 进程     | 构建 `Graft.layer` 处的环境服务。                                                          |
| 共享服务按调用者读取的值：套餐、日志注解        | 加载该子树的一方 | 子树     | `Context.Reference` 上的 intercept。                                                       |
| 服务或处理函数的独立实例：每个租户一份          | 加载该子树的一方 | 子树     | 领域，使用 `isolate`。                                                                     |

| 常见陷阱                              | 规则                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 在每次调用中层层传递租户 ID           | 在子树处对某个 Reference 做一次 intercept，在需要的地方读取它。                                                            |
| 在构建服务时读取 Reference            | `apply` 使用发布者的上下文运行。请在方法的 Effect 内读取，它[使用调用者的上下文运行](../../intercepts/#跟随调用者的设置)。 |
| 在 `graft.yml` 中设置自定义 Reference | 先在宿主中登记它；[`graft start` 只登记了两项](../../intercepts/#配置文件中的-intercept)。                                 |
| 指望领域屏蔽环境服务                  | 领域隔离的是已发布的服务和事件；[消费者会回退到环境](../../isolation/#环境兜底与继承)。                                    |
| 需要运维人员重新配置的环境服务        | 改为由插件发布的服务。环境会一直存活到宿主停止。                                                                           |

## 在共享模块中声明令牌

把跨越插件边界的每个服务键、事件令牌、Reference 和带标签的错误，都放进发布方和消费方共同导入的模块：

```ts title="tokens.ts"
import { Context, Schema, type Effect, type Option } from "effect"

import { Event } from "@graftland/graft"

export class ForecastUnavailable extends Schema.TaggedError<
	ForecastUnavailable,
	{ readonly brand: unique symbol }
>()("ForecastUnavailable", { city: Schema.String }) {}

export class Forecasts extends Context.Service<
	Forecasts,
	{
		readonly today: (
			city: string,
		) => Effect.Effect<Option.Option<string>, ForecastUnavailable>
	}
>()("@acme/graft-plugin-weather/Forecasts") {}

export const ForecastIssued = Event.make<[city: string, forecast: string]>(
	"@acme/graft-plugin-weather/ForecastIssued",
)
```

| 规则                   | 原因                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 键字符串以包名为作用域 | 字符串就是键的身份：字符串相同的两个键就是同一个键。`graft.yml` 也用它在 [`inject`、`isolate` 和 `intercept`](../../config-file/#规则) 中指称这个键。 |
| 实现不放进该模块       | 这样消费方只依赖契约。发布方可以被[替换](../../replace/)或[移到另一个进程](../../remote/overview/)，而不必改动消费方。                                |
| 把预期失败写进方法类型 | 调用方能看到必须处理哪些错误，Remote 契约也能携带它们。                                                                                               |
| 远程方法要粗粒度       | 每次 Remote 调用都要跨越连接。一次接受批量的调用远比多次小调用便宜，见 [Remote 边界的开销](../production/)。                                          |
| 只定义值               | 和所有[插件模块](../../plugins/#插件模块)一样，导入该模块不能执行任何 I/O。                                                                           |

要把令牌和插件作为 npm 包发布，见[插件包](../packaging/)。

## 实例：聊天机器人

[`chat-bot` 示例](https://github.com/graftland/graft/tree/main/samples/chat-bot)
包含 `/roll`、`/weather <city>`、列出已加载命令的
`/help`，以及一个词表可编辑的审核过滤器：

| 部分             | 做成                                            | 原因                                                                   |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| 收到的消息       | 中间件事件 `Inbound`，用 `Event.waterfall` 运行 | 过滤器可以在任何命令看到消息之前包裹、修改或拦下它。                   |
| 命令             | 事件 `Command`，用 `Event.bail` 作答            | 第一个认出命令名的命令作答。                                           |
| 帮助行           | 事件 `Describe`，用 `Event.parallel` 收集       | 每个命令贡献自己的一行，因此 `/help` 永远不会过时。                    |
| 审核             | 带 `Inbound` 处理函数和更新函数的插件           | 新词表原地生效；无效的词表只让审核插件失败。                           |
| 天气客户端       | 发布 `Forecasts` 的插件，通过 Remote 运行       | 它持有一条连接，SDK 崩溃时只会拖垮它自己的进程。                       |
| `/weather`       | 带 `inject: [Forecasts]` 的插件                 | 只在客户端存在时运行，在客户端之前停止，并捕获 `ForecastUnavailable`。 |
| `/roll`、`/help` | 各自一个插件                                    | 每个都能单独启用和停用。                                               |

另外两个示例用同样的问题做设计：

| 示例                                                                                | 展示                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`market-feed`](https://github.com/graftland/graft/tree/main/samples/market-feed)   | 一条服务管道。消费者在 `Pending` 中等待，失败的读取方会撤回整条链，`retry` 调度负责重建。   |
| [`saas-tenants`](https://github.com/graftland/graft/tree/main/samples/saas-tenants) | 每个租户一个组合插件，每个租户的存储一个领域，外加一个读取 intercept 后套餐的共享配额服务。 |

## 设计评审

以下规则全部成立时，设计就可以定稿了：

- 每个部分都对应到插件、服务、事件、领域、intercept、环境服务或配置字段之一。
- 每份状态都有唯一的所属 fork，其他部分通过服务或事件访问它。
- 每个资源都有 Scope，每个后台 fiber 都使用 `Plugin.fork`。
- 插件之间的每次交互都是一个令牌，键以包名为作用域，放在共享模块中。没有任何代码维护注册表、检查某个部分是否存在或安排启动顺序。
- 每个预期失败都有负责恢复的地方。其他失败让所属 fork 失败，在重试有用时配上
  `retry` 调度。
- 每项设置都是配置字段、环境服务、intercept 或领域之一，按谁来设置、存活多久来选择。
- 每个插件都是一个生命周期：它的各个部分一起变化、一起失败、一起重启。
