---
title: HMR API
description: 在自己的程序中使用 @graftland/hmr，无需 CLI。
---

`@graftland/hmr`
包可以脱离 CLI 使用。热重载本身的行为请参阅[热重载](../hot-reload/)。

```ts
import { Effect } from "effect"

import * as Hmr from "@graftland/hmr"

export const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	yield* hmr.importerScoped("./dist/plugin.js")
	return yield* hmr.reload
})
```

`make` 需要 `Graft.Graft` 和 `Scope`。关闭 `Scope`
时会等待进行中的导入完成，再移除模块钩子。导入这个包本身不会启动任何东西。

## 成员

| 成员                                         | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include, activationTimeout })` | `base` 是解析名称所依据的模块 URL，通常是 `import.meta.url`。`include(url)` 决定哪些文件获得新版本：默认是 `node_modules` 之外的所有文件。`activationTimeout` 是重载后的插件启动的时限，超时则回滚重载；默认 30 秒。                                                                                                                                                                                                                  |
| `importer(specifier)`                        | 导入插件模块，登记持续到 HMR 会话关闭。                                                                                                                                                                                                                                                                                                                                                                                               |
| `importerScoped(specifier, options?)`        | 返回需要 `Scope` 的 Effect。每次调用的入口租约持续到该 scope 关闭。参见[带 scope 的 importer](#带-scope-的-importer)。                                                                                                                                                                                                                                                                                                                |
| `reload`                                     | 强制全量重载所有已注册入口及其受跟踪的依赖。返回包含已重载入口的 `Reloaded`；回滚恢复成功时返回带有入口及其[失败](../replace/#回滚)的 `RolledBack`（恢复为 `Pending` 也算成功）；旧代码重启失败时返回 `RecoveryFailed`，带有入口、替换的 `failures` 和恢复失败的 `recovery`，保留完整 cause；变化[无法生效](../hot-reload/#重载未生效的情形)时返回 `Skipped`。模块无法导入或没有导出插件时以 `HmrError` 失败，其 `cause` 是原始错误。 |
| `watch(paths, options)`                      | 一个流：`paths` 下已观察文件的内容或本地解析变化后，增量重载受影响的入口。先等待 `debounce`（默认 50 毫秒）收集更多变化，然后重载。发出与 `reload` 相同的结果，包括 `RecoveryFailed`；导入或检查失败以带完整 cause 的 `Failed` 发出，监听继续。                                                                                                                                                                                       |

## 带 scope 的 importer

| Importer                    | 租约持续到……          | 接受                                  |
| --------------------------- | --------------------- | ------------------------------------- |
| `importer(specifier)`       | 整个 HMR 会话关闭。   | Promise importer。                    |
| `importerScoped(specifier)` | 调用方的 scope 关闭。 | Effect importer 和 Promise importer。 |

在显式开发工具中直接使用带 scope 的 importer。它不是可传递的 Loader 解析器。`graft start`
拒绝监听模式；HMR 的结果属于嵌入式协作，不提供内核隔离或强制回收。

`importerScoped(specifier, { observationScope })`
将观察租约保留到该 scope 关闭；省略此项时使用调用方的 scope。

## 监听

`WatchOptions` 控制流能看到什么：

| 选项                   | 含义                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `filter(absolutePath)` | 决定哪些文件可以触发重载。原生事件和周期内容核对使用同一个谓词；省略时接受所有路径。 |
| `recursive`            | 控制是否包含子目录。                                                                 |
| `debounce`             | 等待更多变化的时长，默认 50 毫秒。                                                   |
| `onReady`              | 表示监听已安装，不保证操作系统会交付每一个事件。                                     |

```ts
import { String } from "effect"

import type * as Hmr from "@graftland/hmr"

declare const hmr: Hmr.Hmr
declare const directory: string

const results = hmr.watch([directory], {
	recursive: true,
	filter: String.endsWith(".mjs"),
})
```

### 处理失败

| 失败                          | 出现的位置                                     |
| ----------------------------- | ---------------------------------------------- |
| 重载失败                      | 包含完整 `Cause` 的 `Failed` 值。              |
| watcher 或内容核对的 I/O 失败 | 流本身失败，因此调用方也需要处理这个错误通道。 |
