---
title: 热重载
description:
  Graft 如何在运行中的 Node.js 进程内替换插件代码，以及这种方式的限制。
---

使用 `graft start --watch`
时，保存插件模块就会用新代码替换正在运行的插件。进程继续运行，不是从插件模块加载的部分也继续运行，例如环境中的服务。

对于[远程插件](../remote/)，重载宿主入口会替换子进程执行；runner 上安装的实现模块不在宿主 HMR 图里。

## 保存后会发生什么

1. Graft 重新导入仍登记的插件模块，形成新的一**代（generation）**。每个模块 URL 都会附加代数标记，Node 的模块钩子也会为插件导入的每个模块赋予这一代的新版本。因此，修改辅助文件也会更新使用它的插件。
2. 如果所有模块都成功导入并仍然导出插件，Graft 会调用
   [`Graft.replace`](../lifecycle/#替换插件)，在一个事务中替换所有新插件。每个模块都产生了新的插件，所以从模块加载的每个 fork 都会按正常的[服务撤回顺序](../services/#服务撤回流程)停止，再用新代码启动。
3. 只要有任何模块导入失败，就不会进行替换。旧代码继续运行，错误及其原因会记录到日志中。唯一的例外是文件已被删除的插件模块：它会从这次重载中移除，其他插件照常替换；它的 fork 继续运行旧代码，直到被卸载。

重载后，之前因插件无法加载而失败的配置项会重新尝试加载，因此修复插件后无需重启进程即可启动它。

相邻文件事件会经过 50 毫秒防抖。CLI 递归监听配置目录中的 `.js`、`.mjs`、`.cjs`、
`.ts`、`.mts` 和 `.cts` 文件，忽略
`node_modules`。YAML 编辑由 loader 单独处理，不会因此重新导入所有插件模块。

原生 watcher 可能漏掉通知，包括 macOS 上的启动窗口。HMR 还会每秒核对监听范围内已加载模块的内容。基线来自模块钩子实际读取的字节，因此可以检测导入后、监听安装前的保存；通过配置新增插件本身不会触发重载。核对比较完整内容，能识别同大小的修改，成本与已加载模块的内容总量相关，监听结束时也会停止。

不完整的写入可能导致重载失败；完整 Cause 会记录到日志，监听继续。后续内容变化即使没有原生事件也能触发恢复。CLI 同样会记录 watcher 的 I/O 失败，并在一秒后重新安装 watcher。

CLI 的模块登记跟随配置项存活。移除或禁用配置项会释放租约；最后一个租约关闭后，该入口不再参与重载。等待依赖和 activation 失败的配置项仍保留租约，以便修改代码后恢复。已卸载的入口及其独占的 CommonJS 依赖不会阻塞其他入口。每次磁盘观察都关联导入尝试的代次及实际读取的内容。新尝试完成后，会重新依据其读取内容核对磁盘，因此文件在快照与导入之间发生变化、再恢复为旧快照时，也能触发恢复。失败尝试若已读取内容，同样更新这一基线；没有新变化时不会陷入失败重试循环。

轮询也跟随租约：文件集合来自存活入口的运行中版本及最近一次尚未提交的导入尝试，保留失败导入和待创建的本地依赖以支持重试。最后一个所有者关闭后，入口及其独占依赖退出轮询；成功替换后，旧依赖图退出轮询。仍有所有者的路径发生真实 I/O 错误时，watch 流仍会失败。

首次导入失败后，观察租约仍由配置项持有，与立即关闭的候选资源 scope 分离。修正模块后，即使原生通知丢失，也能通过轮询恢复。重试替换观察代次，移除或禁用配置项则关闭观察 scope。

两个入口原先导出同一个 Plugin 对象、后来分化成不同对象时，重载返回
`Skipped`，`reason` 为
`ambiguous-exports`，并列出冲突模块 URL。CLI 会提示需要重启，所有旧插件保持不变；恢复共享导出也能让后续重载恢复。新旧替换身份还必须与运行时 alias 一致。例如
`P → Q, Q → R` 无法表达两次独立替换，会返回 `Skipped`，`reason` 为
`identity-conflict`，并列出冲突模块 URL。校验与 alias 发布在同一个事务中进行；冲突会拒绝整批替换，不改变任何 fork。

取消期间才完成的操作会在恢复可中断状态前移交完整 Exit。HMR 会记录原本可能被中断遮蔽的失败，保留完整 Cause。

版本化模块只要导入 `node:module` 或 `module`，HMR 就会保守地要求重启。这在
`createRequire` 命中缓存之前登记原生加载能力，覆盖 `require(esm)`
和 CommonJS；即使只使用该模块的其他工具函数，也会使这张依赖图退出热重载。需要热重载的依赖请使用 ESM 静态或动态导入。

即使没有文件通知，监听也会报告已知的原生加载重启要求，包括启动后才获取该能力的插件。周期性状态检查不会重复报告相同状态；这条警告不表示已经执行重载。

本地文件入口及其可达依赖按代次保留导入方、原始请求路径和物理目标。入口或 helper 符号链接更换目标时，reload 会在替换任何插件之前返回
`Skipped / restart-required`，列出受影响的请求 URL。即使新旧文件内容相同、原生通知丢失，轮询也能检测目标变化。导入前、替换提交前及轮询共用同一份有租约归属的图；失败待重试的依赖图会保留到租约释放。请重启以使用新目标；HMR 不清理 Node 的解析缓存。这项检查不重新解析裸包名或 package
exports 映射。

## 插件模块的规则

- **导入模块不得产生副作用。** Graft 每次重载都会重新导入模块，而只有 `apply`
  运行在 Graft 能关闭的 `Scope` 内。连接、服务器和定时器都应在 `apply` 内启动。
- 只有 ECMAScript 模块可以重载。CommonJS 模块或原生扩展发生变化时，日志会提示需要重启。依赖事实按 generation 记录到会话结束，包括入口导入完成后在
  `apply` 中发生的动态导入；这些依赖同样会让后续重载返回 `Skipped`。
- `node_modules`
  中的包会共享使用，不会重载。Effect 和 Graft 自身必须始终只有一份实例。唯一的例外是插件所在的模块本身：来自某个包的插件会被重新导入，但该包的其他文件不会。
- 支持的最低 Node.js 版本为 22.19，与 CLI 的 Effect Node 适配器要求一致，也提供
  `module.registerHooks`。

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
		importer: hmr.importerScoped,
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
| `importer(specifier)`     | 导入插件模块，登记持续到 HMR 会话关闭。                                                                                                    |
| `reload`                  | 返回包含已重载模块的 `Reloaded`，或在需要重启时返回 `Skipped`。模块无法导入或没有导出插件时以 `HmrError` 失败，其 `cause` 是原始错误。     |
| `watch(paths, options)`   | 一个流：`paths` 下的文件变化后，再等待 `debounce`（默认 50 毫秒）收集更多变化，然后重载。失败的重载以带原因的 `Failed` 发出，监听继续。    |

`importerScoped(specifier)` 返回需要 `Scope`
的 Effect；每次调用的入口租约持续到该 scope 关闭。将它传给
`ModuleResolver.make`，该接口同时接受 Effect importer 和 Promise
importer。Promise 版本 `importer(specifier)` 的登记则持续到整个 HMR 会话结束。

`importerScoped(specifier, { observationScope })`
将观察租约与候选导入的临时资源分开。`ModuleResolver`
通过 importer 的第二个参数传递这个 scope。失败条目等待重试时应保留它，替换观察尝试或移除条目时关闭它；候选资源仍在失败时立即清理。省略该选项时使用调用方的 scope。

原生 watcher 在源资源清理完成后、进入后台合并边界之前观察完整 Exit。包含失败的中断会在这里记录完整 Cause，纯中断保持安静；普通后端失败继续交给消费方处理，不重复记录。

`WatchOptions.filter(absolutePath)`
决定哪些文件可以触发重载。原生事件和周期内容核对使用同一个谓词；省略时接受所有路径。`recursive`
控制是否包含子目录。例如：

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

重载失败以包含完整 `Cause` 的 `Failed`
值发出。watcher 和内容核对的 I/O 失败则会使流本身失败，调用方也需要处理这个错误通道。`onReady`
表示监听已安装，不保证操作系统会交付每一个事件。
