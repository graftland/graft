---
title: 后台 fiber
description: 启动归挂载所有的工作，并让它的失败使挂载失败。
---

Layer 常常启动比构建活得更久的工作：轮询、服务器、订阅者。`Graft.fork`
启动这样的 fiber，并给它一个归属。

## 在 Layer 里 fork

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Events extends Context.Service<Events, string>()("app/Events") {}

export const events = Layer.effect(
	Events,
	Effect.gen(function* () {
		yield* Graft.fork(
			Effect.log("Subscribed").pipe(Effect.andThen(Effect.never)),
		)
		return "ready"
	}),
)
```

这个 fiber 属于正在构建该 Layer 的挂载。挂载被拆除时它被中断，它的失败会使挂载失败。

| 行为                   | 结果                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| 归属                   | 正在运行这个 Layer 的挂载。                                         |
| 拆除时                 | 等挂载的消费者释放租约之后被中断。                                  |
| 失败时                 | 挂载带着 fiber 完整的 `Cause` 变为 `Failed`，然后遵循它的 `retry`。 |
| 纯中断                 | 不会使挂载失败。                                                    |
| 错误类型               | 通过 `Graft.Tasks<E>` 和 `Graft.BackgroundError` 带到挂载上。       |
| 裸 `Effect.forkScoped` | 生命周期跟随 scope，但失败不会到达挂载。                            |

## 在 fiber 内处理错误

失败的 fiber 会连累挂载，所以能在其中恢复的错误就在其中捕获：

```ts
import { Effect, Schedule } from "effect"

import { Graft } from "@graftland/graft"

export const poll = Graft.fork(
	Effect.log("Polling").pipe(
		Effect.andThen(Effect.never),
		Effect.retry(Schedule.exponential("1 second")),
	),
)
```

被 fork 的 fiber 的错误类型是 Layer 契约的一部分：Layer 里 fork 了
`Effect<never, HttpError>` 的挂载可以以 `HttpError` 失败，`mount.await`
会暴露它。见[失败与重试](../failures-retry/)。

## 撤回之后

挂载被拆除时，先撤回它发布的服务，然后消费者释放租约，只有这时才中断后台 fiber。消费者的 finalizer 仍然可以调用它正在使用的服务。

- 仍然健康运行的 fiber 在消费者排空期间继续运行。
- 排空期间失败的 fiber 把它的 `Cause` 加进挂载的失败。
- 所有 fiber 都在挂载的 scope 关闭之前被中断。

把失败应当使挂载失败的工作交给
`Graft.fork`。属于更小 scope、失败在别处报告的工作，用 `Effect.forkScoped`。
