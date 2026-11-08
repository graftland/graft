---
title: 在程序中使用 Graft
description: 从自己的 Effect 程序运行插件，无需 CLI。
---

**嵌入式 Graft**
在你的 Effect 程序内组合插件。生命周期是协作式的，不提供内核 Change 结果、隔离或依靠终止完成的资源回收。

| 你想要……             | 使用                                | 章节                               |
| -------------------- | ----------------------------------- | ---------------------------------- |
| 从代码中加载少量插件 | `Graft.layer` 和 `Graft.plugin`     | [直接运行插件](#直接运行插件)      |
| 从配置项列表加载插件 | `Loader.plugin` 和 `ModuleResolver` | [加载配置项](#加载配置项)          |
| 从 YAML 文件加载插件 | `Include.Include`                   | [加载配置文件](#加载配置文件)      |
| 测试插件             | `@effect/vitest` 和 `Graft.layer`   | [测试](../best-practices/testing/) |

## 直接运行插件

`Graft.layer` 创建运行时。在 `Scope` 内加载插件，关闭 `Scope` 就会卸载它们：

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { greeter, hello } from "./plugins.ts"

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

export const run = () =>
	program.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
		NodeRuntime.runMain,
	)
```

Layer 环境中的服务对所有插件可用，这里就是 Node.js 服务。参见[来自环境的服务](../services/#来自环境的服务)。

`greeter` 和 `hello` 都是普通插件，本页的其他示例也会加载它们。`greeter` 发布
`Greeter` 服务，`hello` 注入它：

```ts title="plugins.ts"
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

export class Greeter extends Context.Service<
	Greeter,
	{ readonly greeting: string }
>()("app/Greeter") {}

export const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: (config) => Graft.provide(Greeter, config),
})

export const hello = Plugin.make({
	name: "app/hello",
	inject: [Greeter],
	apply: () =>
		Effect.flatMap(Greeter, ({ greeting }) =>
			Effect.log(`${greeting}, world!`),
		),
})
```

## 加载配置项

嵌入式 `Loader.plugin`
按配置项列表加载构建后的模块。解析需要有效的公开控制端点来执行可丢弃检查；相对 include 保留声明它的目录。

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address
const resolver = ModuleResolver.layer({ base: "/app", control }).pipe(
	Layer.provide(NodeServices.layer),
)
export const run = () =>
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(Loader.plugin, [
			{ id: "hello", name: "./dist/hello.js" },
		])
		yield* fork.stable
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(NodeServices.layer, resolver),
			),
		),
		NodeRuntime.runMain,
	)
```

| 边界       | 规则                                                     |
| ---------- | -------------------------------------------------------- |
| 解析       | 返回可序列化描述符，在可丢弃单元中检查可执行代码。       |
| 嵌入式激活 | 在嵌入它的进程中运行，以协作方式管理 scope。             |
| 配置       | 原生准备只传递 JSON 和不可变模块身份。                   |
| 保证       | 嵌入式 fork 不提供 Change 结局、强制回收或代码卸载保证。 |

测试使用真实模块文件。源代码变更后先构建，再重启嵌入进程。原生准备及嵌入式编辑服务见
[Loader API](../loader-api/)。

## 加载配置文件

嵌入式程序可通过 `Include.Include` 读取和编辑 YAML，`watch: true`
协作式监听文件修改。`graft start` 只读取一个版本，不支持 `--watch`。

```ts
import { Effect } from "effect"

import { Graft } from "@graftland/graft"
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

| 要求 / 选项 | 说明                                                            |
| ----------- | --------------------------------------------------------------- |
| 服务        | 需要 `FileSystem` 和 `Path`，例如由 `NodeServices.layer` 提供。 |
| `initial`   | 如果文件尚不存在，会用这些初始配置项创建文件。                  |
| `watch`     | 获取手动做的修改。                                              |

从代码中编辑配置项，请参阅 [Loader API](../loader-api/)。
