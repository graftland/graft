---
title: 在程序中使用 Graft
description: 从自己的 Effect 程序运行插件，无需 CLI。
---

CLI 是建立在这些库之上的一个小程序。你也可以用同样的方式，在自己的 Effect 程序中运行 Graft。

## 直接运行插件

`Graft.layer` 创建运行时。在 `Scope` 内加载插件，关闭 `Scope` 就会卸载它们：

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import { Effect, Layer } from "effect"

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

## 加载配置项

`Loader.plugin` 运行保存在内存中的[配置项](../config-file/#配置项字段)列表。通过
`Loader` 服务所做的编辑只修改这份列表。配置项需要 `ModuleResolver`
将名称解析为插件：

```ts
import { Loader, ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Loader.plugin, [
		{ id: "greeter", name: "greeter", config: { greeting: "Hello" } },
		{ id: "hello", name: "hello" },
	])
	return yield* Effect.never
})

const resolver = ModuleResolver.fromRecord({ greeter, hello })
```

`ModuleResolver.fromRecord`
从固定的映射表解析名称，适合打包后的应用和测试。`ModuleResolver.layer({ base, importer })`
则通过导入模块来解析：相对名称从 `base` 解析，包名通过 `importer`
解析。`importer` 通常是在应用中定义的
`(specifier) => import(specifier)`，以便找到应用的依赖。

将解析器和 Node.js 服务一起提供到环境中：

```ts
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

## 加载配置文件

`Include.Include` 是 `graft start`
使用的插件。它读取 YAML 文件并将编辑结果写回；设置 `watch: true`
后，还会监听手动修改：

```ts
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

它需要 `FileSystem` 和 `Path`，例如由 `NodeServices.layer` 提供。使用 `initial`
时，如果文件尚不存在，会用这些初始配置项创建文件。
