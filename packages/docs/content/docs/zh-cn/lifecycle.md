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

| 状态       | 含义                                         |
| ---------- | -------------------------------------------- |
| `Loading`  | 正在解码配置或运行 `apply`。                 |
| `Pending`  | 等待必需服务，`missing` 列出缺失的服务键。   |
| `Active`   | `apply` 已执行完毕，插件正在运行。           |
| `Failed`   | 启动或运行失败，`cause` 包含完整的 `Cause`。 |
| `Disposed` | 已卸载，这是最终状态。                       |

fork 会自动在这些状态之间切换。`Pending`
状态的 fork 在所需服务出现时启动；`Active` 状态的 fork 在所需服务消失时回到
`Pending`；`Failed` 状态的 fork 在配置或依赖变化时，或在 `retry`
调度触发时重试。

retry
driver 的初始化和每一步执行都受同一个变更监督边界管理。配置或依赖变化会取消旧操作，并等待其清理完成后再开始下一次尝试。配置和依赖解析均未改变时，保留原有 Schedule 状态与重试预算。调度失败（包括变更引发的清理失败）会合并进 activation 的
`Failed.cause`。卸载取消 retry 时新发生的失败则进入
`CleanupError.cause`，不会重放此前已经发布的启动失败。

构造或运行 intercept 时的失败同样使 fork 进入
`Failed`。Graft 保留完整的 Cause，并解除 `await`
的等待。retry 调度不会重试这类失败；fork 会等待配置更新、插件替换或显式调用
`restart`。失败归属于 supervisor 当时正在处理的 spec，包括原地更新。已经处理过的更新不会触发再次尝试；清理期间到达的新请求仍保持待处理。

`Plugin.fork` 启动的后台任务属于 activation。除纯中断外的失败，与 `apply`
中的失败走相同的 `Failed`
和 retry 路径。兄弟任务被取消并清理之后，完整的 Cause 仍会保留。

清理按以下顺序进行：停止
`apply`，关闭发布并撤回服务，排空所有消费者，然后停止剩余任务并关闭它们的 Scope。这之后才关闭 activation
Scope，并释放插件自身依赖的 lease。排空期间，健康的任务继续服务消费者的 finalizer，即使本次清理由另一个任务的失败触发也一样。排空期间发生的失败同样保留完整 Cause，并由 Graft 记录日志；如果清理由失败触发，这些失败会并入最终的
`Failed` 状态。裸 `Effect.forkScoped` 不会把后台失败交给这个 supervisor。

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
在请求被处理、被后续请求取代或 fork 已卸载时返回。fork 只保留最新请求的配置，并发更新可能完全跳过中间输入；被取代的更新也会成功返回，即使它的输入从未应用、最新请求仍在等待。成功返回不代表这一次配置已经交付。这些调用不会等待重启完成。使用
`await` 或 `state` 观察 fork 的当前状态；它们不用于确认已经被取代的输入。

并发及重复调用 `dispose` 共享唯一一次关闭操作及其完整结果。其类型是
`Effect<void, Fork.CleanupError>`。`CleanupError.cause` 保存原始的 typed
failure、defect 和混合中断原因，它们来自 apply、被中断的更新、受监督的后台任务、资源及 supervisor 清理。仅有纯中断时按正常停止处理。每个清理阶段仍会执行，包括释放依赖 lease。`Failed.cause`
会合并清理失败和原来的 activation 失败。结果一旦发布为
`Failed`，之后卸载这个处于空闲状态的 fork 不会重放它；恢复后的 activation 使用新的清理结果。

父 Scope 等待同一次清理，因此先开始卸载子插件不会让父资源提前释放。取消等待者不会取消清理。公开的 dispose 在 fork 与父级解除挂接后完成。Scope 自动关闭时，`CleanupError`
通过 defect 报告，因为 Effect 终结器没有 typed
error 通道；错误中仍保留完整的原始 Cause。处理函数请求卸载自己的 fork 时，它自身也会被这次卸载中断。

`await` 将 `Pending`
视为已稳定的状态，因为等待中的 fork 可能永远等不到服务。要等到 fork 真正运行起来，应观察
`state`，等待 `Active`。

## 替换插件

`Graft.replace`
将插件替换为新版本。旧插件的每个 fork 都会使用新版本重启；之后再加载旧插件，也会加载新版本：

```ts
const upgrade = Graft.replace([[greeterV1, greeterV2]])
```

TypeScript 会逐对独立检查。目标插件的输入类型必须与来源完全相同，错误类型必须是来源错误上界的子集。错误上界包含解码失败（`SchemaError`），因此已有 fork 句柄在替换后仍然有效。定义的输入与错误契约是不变的：不能通过把同一个对象赋给更宽的错误类型或更窄的输入类型来绕过检查。需要的错误联合应在创建插件时声明，再加载插件。

动态加载的模块使用参数为 `any` 的
`Plugin`。这一边界刻意擦除了静态契约，HMR 和 loader 仍可使用；它不在运行时验证替换兼容性。显式擦除为
`any` 或使用类型断言，同样可以绕过 TypeScript 的保证。

插件身份由定义对象的引用决定，不由名称或字段决定。复用同一个对象表示同一个插件；`{ ...plugin }`
会创建不同的插件，替换一个副本不会影响其他副本或原对象。加载、alias 查找和冲突检查都遵循这一规则，冻结对象和自定义了
`Equal` 或 `Hash` 的定义也不例外。Graft 不会修改调用方对象上的这些实现。

Graft 在一个事务中应用所有替换关系，任何 fork 都不会看到只完成一部分的替换。随后，每个受影响的 fork 按照正常的[服务撤回顺序](../services/#服务撤回流程)停止并重新启动。[热重载](../hot-reload/)使用的就是
`replace`。

有些批次无法用运行时 alias 表达，会以 `Graft.ReplacementConflict`
失败，`indices` 列出冲突的配对下标。这包括同一来源对应不同目标，以及
`P → Q, Q → R`
这样的重叠变更，还包括会使现有 fork 仍停留在其他插件上的过期来源身份。失败时，事务不会修改 alias 或 fork。以下两种情况仍然受支持：让多个来源指向同一个未变化的目标，以及回退到旧版本。

## 观察应用

`Graft.forks` 是一个流，在每次变化时发出完整的 fork 树。每个节点包含 fork 的
`id`、`name`、`input`、`state` 和 `children`：

```ts
const inspector = Plugin.make({
	name: "inspector",
	apply: () =>
		Graft.forks.pipe(
			Stream.runForEach((trees) => Effect.log(trees)),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

`Graft.logs` 收集使用 `Graft.layer`
的环境中的日志，包括宿主程序日志。新订阅者会先收到最近的 1000 条日志。插件运行时发出的日志带有
`graft.fork` 和 `graft.plugin`
注解；宿主日志保留自己的注解，Graft 不会替它补造插件身份。因此读取日志时应允许这两个注解缺失。
