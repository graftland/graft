---
title: 从 cordis 迁移
description: cordis 的概念在 Graft 和 Effect 中如何对应。
---

Graft 参考了 [cordis](https://github.com/cordiverse/cordis)
的设计：应用由插件树组成，插件发布和使用服务，树可以在运行期间变化。区别在于，Graft 不提供自己的上下文对象、Effect 系统或生命周期辅助工具，而是直接使用 Effect 的能力，只补充 Effect 尚未提供的部分。

## 概念对照

| cordis                                 | Graft                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ctx`，服务作为属性访问                | Effect 环境，通过 `yield* Key` 读取服务。                                                    |
| `ctx.plugin(plugin, config)`           | [`Graft.plugin(plugin, input)`](../lifecycle/#加载插件)，返回一个 fork。                     |
| `ctx.effect()`、可释放对象             | `Effect.acquireRelease`、`Effect.addFinalizer` 和插件的 `Scope`。                            |
| `inject`                               | [`inject`](../plugins/#依赖)，由编译器检查，支持可选依赖。                                   |
| `ctx.provide`、`ctx.set`               | [`Graft.provide`](../services/#发布服务)。                                                   |
| Fiber 状态                             | [fork 状态](../lifecycle/#fork-状态)：`Loading`、`Pending`、`Active`、`Failed`、`Disposed`。 |
| `fiber.update`                         | `apply` 返回的[更新函数](../plugins/#原地更新)。                                             |
| `fiber.restart`                        | `fork.restart`。                                                                             |
| `ctx.isolate`、标签                    | [`isolate`](../isolation/#领域)，对服务和事件都适用。                                        |
| `ctx.intercept`                        | 配合 `Context.Reference` 使用的 [`intercept`](../isolation/#intercept)。                     |
| `registry.replace`                     | [`Graft.replace`](../lifecycle/#替换插件)。                                                  |
| `ctx.on`、`ctx.emit`、`serial`、`bail` | [事件](../events/)：`on`、`emit`、`parallel`、`bail`、`waterfall`。                          |
| 使用 Standard Schema 的配置            | Effect `Schema`，在插件激活期间解码。                                                        |
| 日志、定时器和文件系统插件             | Effect 的 `Logger`、`Schedule`、`Clock` 和 `FileSystem`。                                    |
| 通过 `eval` 执行的 `!!js` 标签         | 只支持 `!env NAME`，配置文件不会执行代码。                                                   |

## Graft 增加的能力

- **依赖检查。** 读取未在 `inject` 中列出的服务会触发类型错误。
- **可选依赖。** `Plugin.optional(Key)`
  允许插件在缺少某个服务时启动，并在该服务出现或消失时重启。
- **固定的清理顺序。**
  先撤回提供方发布的服务，再停止使用这些服务的插件，最后释放提供方的资源。参见[服务撤回流程](../services/#服务撤回流程)。
- **可中断的启动过程。**
  如果插件仍在启动时依赖就消失了，启动过程会被中断，不会继续使用已经消失的服务。
- **带类型且保留原因的失败。** 插件失败时保留完整的 `Cause`，并可按 `Schedule`
  重试。
- **可使用服务的配置解码。** 解码可以异步执行，也可以使用插件的依赖。
- **保留上下文的处理函数。**
  事件处理函数使用自身插件的服务、领域（realm）和 intercept 运行。
- **原子替换。** `Graft.replace` 在一个事务中完成所有插件的替换。

## Graft 不提供的部分

- **上下文代理、mixin 和访问器。** Effect 环境和普通函数即可完成同样的工作。
- **资源树。**
  cordis 可以列出每个插件持有的 effect。Graft 展示 fork 树，资源级别的细节则交给 Effect 的追踪工具。
