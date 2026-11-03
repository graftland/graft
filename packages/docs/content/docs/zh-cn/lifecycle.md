---
title: 生命周期
description: 加载插件、观察状态，并在运行期间修改插件。
---

## 加载插件

`Graft.plugin` 加载插件并返回它的 fork：

```ts
const app = Plugin.make({
	name: "app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

fork 归当前 `Scope` 所有。这个 `Scope` 关闭时，fork 就会卸载。在 `apply`
内，当前 `Scope`
属于插件自身，因此在其中加载的插件就是它的子插件。父插件停止或重启时，子插件也会停止。和父插件
`Scope`
中的其他内容一样，它们按相反顺序释放：在父插件打开某个资源之后加载的子插件，会在该资源关闭之前停止。子插件如果通过
`inject`
使用父插件的服务，则无论顺序如何都会先停止，详见[服务撤回流程](../services/#服务撤回流程)。

第二个参数是插件的输入，由插件的配置 schema 解码。不需要配置的插件无需传入输入。第三个参数包含
[`isolate` 和 `intercept`](../isolation/) 选项。

## fork 状态

fork 始终处于以下某个状态：

| 状态       | 含义                                             |
| ---------- | ------------------------------------------------ |
| `Loading`  | 正在解码配置或运行 `apply`。                     |
| `Pending`  | 等待必需服务，`missing` 列出缺失的服务键。       |
| `Active`   | `apply` 已执行完毕，插件正在运行。               |
| `Failed`   | `apply` 或解码失败，`cause` 包含完整的 `Cause`。 |
| `Disposed` | 已卸载，这是最终状态。                           |

fork 会自动在这些状态之间切换。`Pending`
状态的 fork 在所需服务出现时启动；`Active` 状态的 fork 在所需服务消失时回到
`Pending`；`Failed` 状态的 fork 在配置或依赖变化时，或在 `retry`
调度触发时重试。

## fork 句柄

| 成员            | 作用                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `id`            | 用于在树和日志中标识 fork 的数字。                                         |
| `state`         | 先发出当前状态，再发出每次变化的流，以 `Disposed` 结束。                   |
| `await`         | 等待 fork 离开 `Loading` 状态。如果最终进入 `Failed`，则以插件的错误失败。 |
| `update(input)` | 向 fork 传入新输入。插件会[原地更新](../plugins/#原地更新)或重启。         |
| `restart`       | 使用相同的输入重启插件。                                                   |
| `dispose`       | 卸载插件及其加载的所有内容。                                               |

`update` 和 `restart`
在 fork 响应变更后返回：此时插件已经完成原地更新，或开始重启。它们不会等待重启完成；需要等待时，使用
`await` 或 `state`。

`await` 将 `Pending`
视为已稳定的状态，因为等待中的 fork 可能永远等不到服务。要等到 fork 真正运行起来，应观察
`state`，等待 `Active`。

## 替换插件

`Graft.replace`
将插件替换为新版本。旧插件的每个 fork 都会使用新版本重启；之后再加载旧插件，也会加载新版本：

```ts
const upgrade = Graft.replace([[greeterV1, greeterV2]])
```

所有替换关系在一个事务中应用，任何 fork 都不会看到只完成一部分的替换。随后，每个受影响的 fork 按照正常的[服务撤回顺序](../services/#服务撤回流程)停止并重新启动。[热重载](../hot-reload/)使用的就是
`replace`。

## 观察应用

`Graft.forks` 是一个流，在每次变化时发出完整的 fork 树。每个节点包含 fork 的
`id`、`name`、`input`、`state` 和 `children`：

```ts
const inspector = Plugin.make({
	name: "inspector",
	apply: () =>
		Graft.forks.pipe(
			Stream.runForEach((trees) => Effect.log(trees)),
			Effect.forkScoped,
			Effect.asVoid,
		),
})
```

`Graft.logs`
是包含所有插件日志的流。新订阅者会先收到最近的 1000 条日志。每条日志都有
`graft.fork` 和 `graft.plugin` 注解，可以据此判断日志来自哪个插件。
