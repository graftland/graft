---
title: Intercept
description: 为一个 fork 及其所有后代修改某项设置。
---

intercept 为一个 fork 及其所有后代修改 `Context.Reference`
的值。Reference 是始终有值的键。Effect 自身的设置就是 Reference，例如每行日志附带的注解。

| 你想要……                        | 使用                                                    |
| ------------------------------- | ------------------------------------------------------- |
| 在代码中修改 Reference          | `intercept` 选项中的 `Graft.intercept`。                |
| 在 `graft.yml` 中修改 Reference | 已登记的[配置文件 intercept](#配置文件中的-intercept)。 |
| 让 fork 拥有自己的服务或事件    | 改用[领域](../isolation/)。                             |

## 修改 Reference

```ts import.meta.vitest name="intercepts: change a reference"
import { Effect, References, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const tenant = Plugin.make({
	name: "tenant",
	config: Schema.Struct({ name: Schema.String }),
	apply: () => Effect.log("ready"),
})

const tenantA = Graft.plugin(
	tenant,
	{ name: "a" },
	{
		intercept: [
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: "a",
			})),
		],
	},
)

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* (yield* tenantA).await
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(
		Effect.annotateLogs({ app: "shop" }),
		Effect.scoped,
		Effect.provide(Graft.layer),
	),
)
line?.annotations["tenant"] // => "a"
line?.annotations["app"] // => "shop"
```

函数接收外层的值，因此 intercept 可以嵌套：该 fork 及其后代插件输出的每行日志都会带上
`tenant: "a"`，同时保留上层添加的注解。

## 跟随调用者的设置

如果某项设置需要由服务从调用者处读取，可以使用 Reference。返回 Effect 的服务方法在调用者的 fiber 中运行，因此能读到调用者的 intercept：

```ts import.meta.vitest name="intercepts: settings that follow the caller"
import { Context, Effect, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

const greeter = Plugin.make({
	name: "greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("Ada")),
})

const messages = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(greeter)
		yield* (yield* Graft.plugin(hello)).await
		const formal = Graft.intercept(Formal, () => true)
		yield* (yield* Graft.plugin(hello, undefined, { intercept: [formal] }))
			.await
		return yield* Graft.logs.pipe(
			Stream.take(2),
			Stream.map((line) => line.message),
			Stream.runCollect,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
messages // => [["Hi, Ada!"], ["Good day, Ada."]]
```

加载插件时使用 `Graft.intercept(Formal, () => true)`，就能让它从大家共用的同一个
`Greeter` 收到正式的问候。

## `inject` 中的 Reference

Reference 也可以列在 `inject` 中。

- 本 fork 所在领域的 provision 优先于 intercept 的兜底值。
- 子插件先剥离父级 provision，再应用自己的 intercept；它们会保留父级的兜底值，包括被该 provision 遮蔽的 intercept。

## 配置文件中的 intercept

`Graft.intercept` 是类型化的代码 API；加载器的 YAML `intercept`
字段则是不可信边界，不接受任意字符串键，必须显式登记。

每项登记包含三部分：

| 部分      | 说明                                   |
| --------- | -------------------------------------- |
| Reference | `Context.Reference` 对象。             |
| Schema    | 解码配置的输入。                       |
| 合并函数  | 类型化函数 `(outer, patch) => value`。 |

在运行加载器的环境中登记，与插件解析器和其他平台服务放在一起：

```ts import.meta.vitest name="intercepts: register a reference"
import { Context, Effect, Layer, Schema, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Intercept, Loader, ModuleResolver } from "@graftland/loader"

const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})

const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.String),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const show = Plugin.make({
	name: "show",
	apply: () => Effect.flatMap(Settings, Effect.log),
})

const environment = Layer.merge(references, ModuleResolver.fromRecord({ show }))
const runtime = Layer.provideMerge(Graft.layer, environment)

const [line] = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.plugin(Loader.plugin, [
			{
				id: "show",
				name: "show",
				intercept: { "app/Settings": { color: "red" } },
			},
		])
		return yield* Graft.logs.pipe(Stream.take(1), Stream.runCollect)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)
line?.message // => [{ color: "red", size: 12 }]
```

在 `graft.yml` 中，同一配置项写作：

```yaml title="graft.yml"
- id: show
  name: show
  intercept:
    app/Settings:
      color: red
```

值的合并规则：

- 嵌套配置项的补丁接收父级值，兄弟项保留各自的值。
- Schema 在合并函数运行前解码输入，且不能依赖解码服务。
- 合并函数的返回类型必须匹配 Reference。
- 标量替换或需要整体校验的设置，可使用完整值 Schema，配合
  `(_, value) => value`。

失败情形：

| 问题     | 错误                                         |
| -------- | -------------------------------------------- |
| 键未登记 | `UnregisteredReference`                      |
| 值无效   | `InvalidIntercept`，cause 中保留 Schema 错误 |

这两种情况下，该配置项的插件都不会启动。

:::note

登记表默认为空。应在创建加载器前通过宿主环境提供登记表；加载器管理树中的插件不能通过发布服务来登记 Reference。默认 CLI 登记了
`References.CurrentLogAnnotations`（合并日志注解字段）和
`References.MinimumLogLevel`（校验后替换日志级别）；其他 Reference 需要由自定义宿主登记。直接从代码使用的类型化
`Graft.intercept` API 不受此影响。

:::
