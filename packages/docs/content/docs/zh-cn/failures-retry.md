---
title: 失败与重试
description: 读取失败挂载的 Cause，选择重试计划，并弄清各个错误的含义。
---

失败的挂载不会消失。它进入 `Failed`，保留完整的
`Cause`，等待一次变化或它的重试计划。

## 读取失败

`mount.await` 以挂载的错误失败；`mount.state` 发出带有同一个 `Cause` 的 `Failed`
状态。

```ts import.meta.vitest name="failures-retry: a failed build keeps its cause"
import { Context, Effect, Exit, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const failed = Layer.effect(Greeting, Effect.fail("no greeting"))

const failure = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(failed, { name: "greeting" })
		return yield* Effect.exit(mount.await)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
Exit.isFailure(failure) // => true
```

这个 `Cause` 保留类型化错误、defect 和中断原因。清理失败也会并入同一个
`Cause`，所以 Layer 拆除期间失败的 finalizer 不会丢失。

## 清理缺陷会把启动失败改判为缺陷

当 Layer 构建失败，且同一次构建的清理中有 finalizer 以 defect 结束时，Effect 会把构建的类型化失败改判为 defect（与
`Effect.scoped` 一致）。因此在挂载的 `Failed` cause 中，启动错误以 `Die`
出现，`catchTag` 无法匹配。

| 情况                                    | 启动错误在 cause 中的形态       |
| --------------------------------------- | ------------------------------- |
| 构建失败，清理正常                      | `Fail`，保留 Layer 的类型化错误 |
| 构建失败，且有 finalizer 以 defect 结束 | `Die`，`catchTag` 无法匹配      |

若需要保留类型化的启动错误，finalizer 应以类型化失败或不失败的方式结束。

## 重试失败的挂载

传入一个 Effect `Schedule` 作为 `retry`，在失败后重建：

```ts
import { Context, Effect, Layer, Schedule } from "effect"

import { Graft } from "@graftland/graft"

class Connection extends Context.Service<Connection, string>()(
	"app/Connection",
) {}

declare const connect: Effect.Effect<string, Error>

export const connection = Layer.effect(
	Connection,
	connect.pipe(Effect.retry(Schedule.exponential("1 second"))),
)

export const program = Graft.mount(connection, {
	name: "connection",
	retry: Schedule.exponential("1 second"),
})
```

| 情况                   | 发生什么                                          |
| ---------------------- | ------------------------------------------------- |
| 构建失败，设置了计划   | 挂载保持 `Failed`，然后按计划重试。               |
| 构建失败，没有设置计划 | 挂载只尝试一次，保持 `Failed`，等待一次变化。     |
| 计划要求零延迟         | 每次下一次重试至少等待 1 毫秒，这次等待可被中断。 |
| 计划要求正延迟         | 挂载正好等待该延迟，不额外增加。                  |
| 等待期间挂载被卸载     | 这次等待被取消。                                  |
| 依赖或挂载规格变化     | 取消当前的重试，清理完成后开始新的尝试。          |
| 什么都没变             | 计划在两次尝试之间保留自己的步进和预算。          |
| 发布冲突阻塞了挂载     | Graft 等待图发生变化，而不是反复重试进同一个环。  |

再次失败的重试把新的失败与之前的 `Cause`
合并。挂载在整个过程中都可以观察，也可以重启。

`mount.await` 不会等重试成功。它在第一次 `Failed` 时结束，并以该 `Cause`
失败；`retry` 计划在后台继续。用 `state` 观察后续的尝试。

## 错误名称

| 错误                         | 何时产生                                                   | 怎么办                                   |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `Graft.ServiceConflict`      | 领域里已经有服务提供者，或者发布会导致重建它自己的提供者。 | 读取 `reason`；见下文。                  |
| `Graft.ServiceWithdrawn`     | `Graft.use` 使用的值在运行期间被撤回。                     | 重试这项工作，或用 `watch` 等待该值。    |
| `Mount.CleanupError`         | `unmount` 或自动关闭 scope 时，释放资源遇到失败。          | 读取 `cause`；它保留原始失败和 defect。  |
| `Release.ReleaseInterrupted` | 外层释放正在被取消时，finalizer 自己中断了。               | 当作 defect 处理；`cause` 保留那次中断。 |

### ServiceConflict

| `reason`          | 含义                               |
| ----------------- | ---------------------------------- |
| _（无）_          | 另一个挂载或发布已经提供了这个键。 |
| `SelfDependency`  | 发布会导致直接重建提供者自己。     |
| `DependencyCycle` | 同样的情形，但经过其他挂载。       |
| `Invalidated`     | 依赖变化已经使提供者失效。         |

这个错误还带有服务名、它的领域，以及尝试发布的挂载 ID。

## 失败落在哪里

| 来源                        | 结果                                     |
| --------------------------- | ---------------------------------------- |
| 构建 Layer                  | `Failed`，带有构建的 `Cause`。           |
| `Graft.fork` 的 fiber 失败  | `Failed`，带有该 fiber 的 `Cause`。      |
| 资源 finalizer 失败         | 并入运行它的那次拆除的 `Cause`。         |
| 裸 `Effect.forkScoped` 失败 | 通过该 fiber 的 scope 报告，不交给挂载。 |

失败会启动正常的[拆除顺序](../lifecycle/#拆除顺序)。健康的后台 fiber 继续为消费者服务，直到它们的租约被释放。
