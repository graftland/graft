---
title: 在程序中使用 Graft
description: 从自己的 Effect 程序运行插件，无需 CLI。
---

CLI 是建立在这些库之上的一个小程序。你也可以用同样的方式，在自己的 Effect 程序中运行 Graft。

| 你想要……                 | 使用                                | 章节                               |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| 从代码中加载少量插件     | `Graft.layer` 和 `Graft.plugin`     | [直接运行插件](#直接运行插件)      |
| 从配置项列表加载插件     | `Loader.plugin` 和 `ModuleResolver` | [加载配置项](#加载配置项)          |
| 从 YAML 文件加载插件     | `Include.Include`                   | [加载配置文件](#加载配置文件)      |
| 不使用 CLI 也能重载代码  | `@graftland/hmr`                    | [HMR API](../hmr-api/)             |
| 让插件在另一个进程中运行 | `Remote.plugin`                     | [在别处运行插件](#在别处运行插件)  |
| 测试插件                 | `@effect/vitest` 和 `Graft.layer`   | [测试](../best-practices/testing/) |

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

`Loader.plugin` 运行保存在内存中的[配置项](../config-file/#配置项字段)列表。通过
`Loader` 服务所做的编辑只修改这份列表。配置项需要 `ModuleResolver`
将名称解析为插件：

```ts import.meta.vitest name="embedding: load entries"
import { Effect, Layer, Option, Stream } from "effect"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import { greeter, hello } from "./plugins.ts"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Loader.plugin, [
		{ id: "greeter", name: "greeter", config: { greeting: "Hello" } },
		{ id: "hello", name: "hello" },
	])
	return yield* Graft.logs.pipe(
		Stream.map((log) => log.message),
		Stream.runHead,
	)
})

const resolver = ModuleResolver.fromRecord({ greeter, hello })

await Effect.runPromise(
	program.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
	),
) // => Option.some(["Hello, world!"])
```

`Group.Group`
也接受没有 id 的条目。插入不同名称的条目不会改变已有条目的派生 id；插入或移动同名条目时，请显式指定 id。见[托管条目](../plugins/#托管条目)。

### 选择解析器

| 解析器                                     | 如何找到插件                                                 | 适用于             |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------ |
| `ModuleResolver.fromRecord(table)`         | 从固定的映射表解析。                                         | 打包后的应用、测试 |
| `ModuleResolver.layer({ base, importer })` | 导入模块。相对名称从 `base` 解析，包名通过 `importer` 解析。 | 带有插件文件的应用 |

`importer` 通常是在应用中编写的
`(specifier) => import(specifier)`，以便找到应用的依赖。

在应用中，将解析器和 Node.js 服务一起提供到环境中：

```ts
import { Effect, Layer, type Scope } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import type { ModuleResolver } from "@graftland/loader"

declare const program: Effect.Effect<never, never, Graft.Graft | Scope.Scope>
declare const resolver: Layer.Layer<ModuleResolver.ModuleResolver>

program.pipe(
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

### 解析计划

`ModuleResolver.make` 缓存规范化的候选计划，不缓存 importer 的结果。

- 不提供可选的 `resolution` 环境时，每次调用仍先尝试原始名称，再按命名约定尝试。
- 成功的 importer 每次都会执行，因此自定义 importer 的逐次调用行为和资源 scope 保持不变。

`resolution` 环境可以跳过已知不存在的候选：

| 成员                                        | 作用                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `revision`                                  | 返回解析环境版本的 Effect。安装、移除依赖或其他解析变化后应推进版本，使旧计划失效，包括“不存在”的判断。        |
| `exists(specifier)`                         | 检查规范化候选是否存在，不导入模块，也不获取资源；候选优先级保持不变。                                         |
| `observe(specifiers, { observationScope })` | 在每次解析时执行，包括缓存命中和计划失败，用于保留缺失名称或路径的观察。资源仍归候选 scope 和观察 scope 所有。 |

:::caution

启用这个协议时，必须同时提供失效机制和观察机制。无法可靠维护 `revision`
时，不要设置 `resolution`。尚未完成的旧计划不会覆盖较新版本的缓存。

:::

## 加载配置文件

`Include.Include` 是 `graft start`
使用的插件。它读取 YAML 文件并将编辑结果写回；设置 `watch: true`
后，还会获取你手动做的修改：

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

## 在别处运行插件

`@graftland/plugin-remote` 的 `Remote.plugin`
会构建一个插件，让契约的实现在子进程、worker 或 runner 上运行。像其他插件一样用
`Graft.plugin` 加载它：

```ts
import { Effect, Layer, type Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { hello } from "./plugins.ts"

declare const contract: Remote.Contract.Contract<
	Schema.Struct<{ readonly greeting: Schema.String }>
>

const greeter = Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
})

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto),
		),
	),
	NodeRuntime.runMain,
)
```

Remote 需要环境中有 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`。`hello` 仍然像以前一样注入
`Greeter`。契约和其他选项见[从 TypeScript 加载](../remote/hosts/#从-typescript-加载)。
