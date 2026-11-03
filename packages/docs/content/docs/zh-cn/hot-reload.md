---
title: 热重载
description:
  Graft 如何在运行中的 Node.js 进程内替换插件代码，以及这种方式的限制。
---

使用 `graft start --watch`
时，保存插件模块就会用新代码替换正在运行的插件。进程继续运行，不是从插件模块加载的部分也继续运行，例如环境中的服务。

## 保存后会发生什么

1. Graft 重新导入所有插件模块，形成新的一**代（generation）**。每个模块 URL 都会附加代数标记，Node 的模块钩子也会为插件导入的每个模块赋予这一代的新版本。因此，修改辅助文件也会更新使用它的插件。
2. 如果所有模块都成功导入并仍然导出插件，Graft 会调用
   [`Graft.replace`](../lifecycle/#替换插件)，在一个事务中替换所有新插件。每个模块都产生了新的插件，所以从模块加载的每个 fork 都会按正常的[服务撤回顺序](../services/#服务撤回流程)停止，再用新代码启动。
3. 只要有任何模块导入失败，就不会进行替换。旧代码继续运行，错误及其原因会记录到日志中。唯一的例外是文件已被删除的插件模块：它会从这次重载中移除，其他插件照常替换；它的 fork 继续运行旧代码，直到被卸载。

重载后，之前因插件无法加载而失败的配置项会重新尝试加载，因此修复插件后无需重启进程即可启动它。

一次保存触发的多个文件事件会合并为一次重载。

## 插件模块的规则

- **导入模块不得产生副作用。** Graft 每次重载都会重新导入模块，而只有 `apply`
  运行在 Graft 能关闭的 `Scope` 内。连接、服务器和定时器都应在 `apply` 内启动。
- 只有 ECMAScript 模块可以重载。CommonJS 模块或原生扩展发生变化时，日志会提示需要重启。
- `node_modules`
  中的包会共享使用，不会重载。Effect 和 Graft 自身必须始终只有一份实例。唯一的例外是插件所在的模块本身：来自某个包的插件会被重新导入，但该包的其他文件不会。
- 需要 Node.js 22.15 或更高版本，以使用 `module.registerHooks`。

## 限制

Node 会将导入过的每个模块版本保留在内存中，且无法移除。因此，每次重载都会占用一部分无法释放的内存。开发期间通常可以接受，但长期运行的开发进程应定期重启，生产环境中则不应使用
`--watch`。

如果导入始终无法完成，例如模块顶层的 `await`
一直不返回，后续重载和关闭流程都会被阻塞，因为动态导入无法取消。

## 在自己的程序中使用

`@graftland/hmr` 包可以独立于 CLI 使用：

```ts
import * as Hmr from "@graftland/hmr"
import { ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: hmr.importer,
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	// ...load plugins through the resolver, then, after files changed:
	const result = yield* hmr.reload
	yield* Effect.log(result)
})
```

`make` 需要 `Graft.Graft` 和 `Scope`。关闭 `Scope`
时会等待进行中的导入完成，再移除模块钩子。导入这个包本身不会启动任何东西。

| 成员                      | 作用                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `make({ base, include })` | `base` 是解析名称所依据的模块 URL，通常是 `import.meta.url`。`include(url)` 决定哪些文件获得新版本：默认是 `node_modules` 之外的所有文件。 |
| `importer(specifier)`     | 导入插件模块并记住它，使下一次重载包含它。把它传给 `ModuleResolver`。                                                                      |
| `reload`                  | 返回包含已重载模块的 `Reloaded`，或在需要重启时返回 `Skipped`。模块无法导入或没有导出插件时以 `HmrError` 失败，其 `cause` 是原始错误。     |
| `watch(paths, options)`   | 一个流：`paths` 下的文件变化后，再等待 `debounce`（默认 50 毫秒）收集更多变化，然后重载。失败的重载以带原因的 `Failed` 发出，监听继续。    |
