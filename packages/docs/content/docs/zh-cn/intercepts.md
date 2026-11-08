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
	name: "app/tenant",
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
	name: "app/greeter",
	apply: () =>
		Graft.provide(Greeter, {
			greet: (name) =>
				Effect.flatMap(Formal, (formal) =>
					Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
				),
		}),
})

const hello = Plugin.make({
	name: "app/hello",
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

原生准备过程传递有序的 JSON 补丁和不可变的环境模块描述符。解码和合并代码在检查单元与执行单元中运行。环境模块导出 Layer，`Configuration.Options`
提供编码后的选项。

```ts title="settings.ts"
import { Context, Effect, Layer, Schema } from "effect"

import { Configuration } from "@graftland/plugin-remote"

export const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})
const Patch = Schema.Struct({
	color: Schema.optionalKey(Schema.Trim),
	size: Schema.optionalKey(Schema.Finite),
})
export default Layer.effect(
	Settings,
	Effect.gen(function* () {
		const input = yield* Configuration.Options
		const patch = yield* Schema.decodeUnknownEffect(Patch)(input)
		const outer = yield* Settings
		return { ...outer, ...patch }
	}),
)
```

按 Reference 的键登记模块描述符，再准备插件；准备不会激活插件。

```ts
import { Effect, HashMap } from "effect"

import { ModuleResolver, Preparation } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address

export const prepared = Effect.gen(function* () {
	const resolver = yield* ModuleResolver.make({ base: "/app", control })
	const module = yield* resolver.resolve("@acme/graft-plugin-api")
	const settings = yield* resolver.resolve("./dist/settings.js", {
		kind: "Environment",
	})
	const prepare = yield* Preparation.make({
		control,
		intercepts: HashMap.make(["app/Settings", settings]),
	})
	return yield* prepare.inspect({
		instance: "api",
		module,
		input: { port: 8080 },
		intercept: [{ key: "app/Settings", patch: { color: "red" } }],
	})
})
```

| 输入           | 规则                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| 继承           | 先应用父级补丁，再应用子级补丁；每份配置都构建新的 Layer。             |
| 未登记的键     | 在启动单元前返回 `PreparationFailed`，原因为 `UnregisteredIntercept`。 |
| 无效补丁       | 检查保留完整 cause 并失败，不调用插件的 apply。                        |
| 函数和活动对象 | 因不是 JSON 数据而被拒绝。                                             |
| 恢复           | 重新构建环境，并按当前策略重新解析引用。                               |

显式嵌入的应用可以用 `Intercept.make` 和 `Intercept.layer`
登记单元内部的解码与合并逻辑。这些函数和环境服务不会跨越原生边界。准备过程见
[Loader API](../loader-api/)，协作式组合见[嵌入](../embedding/)。
