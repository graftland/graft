---
title: 生命周期
description: 加载插件、观察状态，并在运行期间修改插件。
---

## 加载插件

`Graft.plugin` 加载插件并返回它的 fork（参见 [fork 句柄](../fork-handle/)）：

```ts title="app.ts"
import { Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) => Effect.log(`${greeting}, world`),
})

export const app = Plugin.make({
	name: "app/app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

| 参数    | 含义                                                   |
| ------- | ------------------------------------------------------ |
| 第 1 个 | 插件。                                                 |
| 第 2 个 | 插件的输入，由其配置 schema 解码。没有配置时可以省略。 |
| 第 3 个 | 选项：[`isolate` 和 `intercept`](../isolation/)。      |

### 归属与停止顺序

fork 归当前 `Scope` 所有。这个 Scope 关闭时，fork 就会卸载。在 `apply`
内，当前 Scope 属于插件自身，因此在其中加载的插件就是它的子插件。

- 父插件停止或重启时，子插件也会停止。
- 和父插件 Scope 中的其他内容一样，它们按相反顺序释放：在父插件打开某个资源之后加载的子插件，会在该资源关闭之前停止。
- 子插件如果通过 `inject`
  使用父插件的服务，则无论顺序如何都会先停止。参见[服务撤回流程](../services/#服务撤回流程)。

## fork 状态

fork 始终处于以下某个状态：

| 状态       | 含义                                         |
| ---------- | -------------------------------------------- |
| `Loading`  | 正在解码配置或运行 `apply`。                 |
| `Pending`  | 等待必需服务，`missing` 列出缺失的服务键。   |
| `Active`   | `apply` 已执行完毕，插件正在运行。           |
| `Failed`   | 启动或运行失败，`cause` 包含完整的 `Cause`。 |
| `Disposed` | 已卸载，这是最终状态。                       |

fork 会自动在这些状态之间切换：

| 从        | 到         | 时机                                  |
| --------- | ---------- | ------------------------------------- |
| `Pending` | `Loading`  | 所需的必需服务出现。                  |
| `Active`  | `Pending`  | 所需的服务消失。                      |
| `Failed`  | `Loading`  | 配置或依赖变化，或 `retry` 调度触发。 |
| 任意      | `Disposed` | fork 被卸载，或其父 Scope 关闭。      |

### 失败与重试

| 失败来源                         | 结果                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `apply`                          | `Failed`，然后走正常的 `retry` 路径。                                            |
| `Plugin.fork` 任务（纯中断除外） | 与 `apply` 相同。兄弟任务被取消并清理之后，完整的 `Cause` 仍会保留。             |
| 构造或运行 intercept             | 以完整的 `Cause` 进入 `Failed`，`await` 结束。`retry` 调度**不会**重试这类失败。 |
| 裸 `Effect.forkScoped`           | 不会报告给 supervisor。                                                          |

对于 intercept 失败，fork 会等待配置更新或显式调用
`restart`。失败归属于 supervisor 当时正在处理的 spec，包括原地更新。已经处理过的更新不会触发再次尝试，清理期间到达的新请求仍保持待处理。

重试与变更的交互方式：

- retry driver 的初始化和每一步执行都受同一个变更监督管理。
- 配置或依赖变化会取消过时的操作，并等待其清理完成后再开始下一次尝试。
- 配置和依赖解析均未改变时，保留原有 `Schedule` 状态与重试预算。
- 调度失败（包括变更引发的清理失败）会并入 activation 的 `Failed`
  `Cause`。卸载取消 retry 时新发生的失败则属于
  `CleanupError.cause`，不会重放此前已经发布的启动失败。

### 清理顺序

1. 停止 `apply`。
2. 关闭发布并撤回服务。
3. 排空所有消费者。健康任务继续服务消费者的终结器，即使本次清理由另一个任务的失败触发也一样。
4. 停止剩余任务并关闭它们的 Scope。
5. 关闭 activation Scope。
6. 释放插件自身的依赖 lease。

排空期间发生的失败保留完整
`Cause`，并由 Graft 记录日志。如果清理由失败触发，这些失败会并入最终的 `Failed`
状态。

## 观察应用

### Fork 树

`Graft.forks` 是整棵 fork 树的流，每次变化都会再次发出。每个节点包含 fork 的
`id`、`name`、`input`、`state` 和 `children`：

```ts import.meta.vitest name="lifecycle: read the fork tree"
import { Effect, Option, Stream } from "effect"

import { Fork, Graft } from "@graftland/graft"

import { app } from "./app.ts"

const trees = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(app)
		yield* fork.stable
		return yield* Stream.runHead(Graft.forks)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

trees // => Option.some([{ id: 1, name: "app/app", input: undefined, state: Fork.ForkState.Active(), children: [{ id: 2, name: "app/greeter", input: { greeting: "Hello" }, state: Fork.ForkState.Active(), children: [] }] }])
```

### 日志

`Graft.logs` 收集使用 `Graft.layer` 的环境中的日志，包括宿主程序的日志。

- 新订阅者会先收到最近的 1000 条日志。
- 插件运行时发出的日志带有 `graft.fork` 和 `graft.plugin` 注解。
- 宿主日志保留自己的注解。Graft 不会替它们补造插件身份，因此读取日志时应允许这些注解缺失。
- 日志级别、自定义注解和 span，见[日志与追踪](../best-practices/observability/)。

## 相关页面

| 页面                                           | 内容                                                |
| ---------------------------------------------- | --------------------------------------------------- |
| [Fork 句柄](../fork-handle/)                   | `await`、`stable`、`update`、`restart`、`dispose`。 |
| [变更](../transitions/)                        | 在内核中部署插件的新版本。                          |
| [错误](../errors/)                             | 所有具名的错误以及应对方法。                        |
| [故障排查](../best-practices/troubleshooting/) | 找出 fork 为何没有启动或什么也不做。                |
