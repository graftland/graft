---
title: 服务
description: 在运行期间发布服务，以及 Graft 如何安全地撤回服务。
---

Graft 中的服务就是普通的 Effect `Context`
键及其对应的值。Graft 增加了两点能力：可以在应用运行期间发布和撤回服务；使用某个服务的插件会在该服务释放之前停止。

## 发布服务

在 `apply` 内调用 `Graft.provide`：

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect } from "effect"

class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

const clock = Plugin.make({
	name: "clock",
	apply: () => Graft.provide(Clock, { now: Effect.sync(() => Date.now()) }),
})
```

服务归发布它的 fork 所有，在该 fork 卸载或重启前一直可用。一个 fork 可以发布任意数量的服务。

在同一个[领域（realm）](../isolation/)内，一个键只能由一个 fork 发布。再次对同一个键调用
`Graft.provide` 会以 `ServiceConflict`
失败。要切换服务实现，可以替换发布它的插件，或使用
[`Graft.replace`](../lifecycle/#替换插件)。

## 使用服务

将服务键列入 `inject`，然后通过 `yield*` 读取：

```ts
const uptime = Plugin.make({
	name: "uptime",
	inject: [Clock],
	apply: () =>
		Effect.gen(function* () {
			const clock = yield* Clock
			const started = yield* clock.now
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(clock.now, (now) =>
					Effect.log(`Ran for ${now - started} ms`),
				),
			)
		}),
})
```

上面的终结器在插件停止时调用
`clock`。这样做是安全的：在所有注入该服务的插件停止之前，服务始终可用。

## 服务撤回流程

发布服务的 fork 停止时，Graft 依次执行以下步骤：

1. 如果 `apply` 仍在运行，先停止它。
2. 在一个事务中关闭发布并撤回该 fork 的服务。此后新消费者不能取得 lease，该 activation 也不能再发布服务。
3. 等待已有消费者释放全部 lease。期间健康的 `Plugin.fork`
   任务及其资源继续服务消费者的 finalizer。随后消费者重启：若有环境兜底值，消费者使用它重启；否则，有必选依赖的消费者进入
   `Pending`，有可选依赖的消费者则在缺少该服务的情况下重启。
4. 停止剩余的受监督任务并关闭其 Scope，等待取消清理完成。
5. 关闭 activation Scope，执行终结器、停止子插件并移除事件处理函数。
6. 释放该 fork 自身持有的依赖 lease。

任务失败触发的清理也遵循这一顺序。失败的任务已经停止，健康任务继续运行，直到消费者排空。Graft 会收集排空期间出现的其他任务失败，并记录它们的完整 Cause，包括清理 defect。由失败触发的清理会将这些 Cause 纳入最终的
`Failed`
状态。资源终结器的失败也会纳入其中，不会阻断后续清理阶段，也不会妨碍依赖 lease 的释放。显式
`dispose` 以 `Fork.CleanupError` 报告清理失败，其 `cause` 保留原始失败原因。

关闭期间，健康任务的资源和 activation 的资源会一直保持存活，直到持有 lease 的消费者结束，与终结器的注册顺序无关。第 3 步超过 10 秒时，Graft 会记录警告：可能有两个插件在互相等待。

插件一旦开始使用某个服务，就会一直持有它，直到自身停止。Graft 在检查插件依赖的同一个事务中记录这些使用关系，因此服务不会在插件启动到一半时被撤回。

## 来自环境的服务

构建 `Graft.layer` 时所在环境中的服务对所有插件可见。它们可以满足 `inject`
声明，生命周期与该环境一致：

```ts
import { NodeServices } from "@effect/platform-node"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

使用这个 Layer 后，插件可以直接注入 `FileSystem.FileSystem` 或
`Path.Path`。与整个应用生命周期一致的服务适合放在环境中。

对于 `inject`
中的每个键，Graft 先在消费者所在领域的注册表中查找；找不到时，才使用环境值。必选和可选依赖遵循相同规则。使用环境兜底的消费者仍会监视自己的领域：同键 provision 出现时，消费者重启并改用发布值；provision 被撤回后，消费者再次重启并回落到环境值。因此，无论先加载消费者还是先发布服务，消费者最终都会使用相同的值。发布操作不会等待已有消费者完成重启。

需要这种查找和重启行为时，请使用 `inject`。通过 `Effect.serviceOption`
读取未声明的键只会读取 activation 的 context，不会订阅注册表变化，也不会取得 provision 的 lease。

`inject` 中的 `Context.Reference` 始终有兜底值，因此不会让插件停在
`Pending`。消费者所在领域的 provision 优先；否则 Graft 使用继承的 Reference 值（包含 intercept），或 Reference 的默认值。它和其他注入键一样监视发布与撤回。

## 发布导致的依赖环

如果一次发布会导致发布者自身重启，Graft 会拒绝它。Graft 在发布服务的同一个事务中进行检查。它先找出在同一领域中通过 ambient 兜底或缺席的可选依赖监视该键的运行中消费者，再沿着这些消费者的子树、受影响 provider 的消费者扩展，直到不再有 fork 会被停止。如果发布者也在其中，注册表保持不变，`Graft.provide`
以 `ServiceConflict` 失败。`Pending`
fork 的必选依赖是在等待启动，不属于重启 watcher。

直接自依赖的错误 `reason` 为 `"SelfDependency"`，间接环为
`"DependencyCycle"`。错误还携带发布者的 `fork` ID 和服务的
`realm`。包装环境服务时，请为输入和输出使用不同的键。若发布者的 resolution 已因依赖变化而失效，也不能发布，此时
`reason` 为 `"Invalidated"`。

如果环错误从 `apply` 或 `Plugin.fork`
任务传播出来，Graft 会清理发布者，发布者进入
`Failed`。随后它等待配置、依赖或图发生变化，而不会按 retry
schedule 反复撞上同一个环。重试之前，Graft 会先把失败 fork 预期取得的依赖放回图中再做检查。清理期间释放 fork 的 lease，本身并不能解除环。

拒绝发布不会写入服务值，也不会触发已有 watcher 重启。正常的失败传播仍然适用：等待子插件失败的插件可能随之失败；失败的 fork 之前已发布的服务被撤回时，其消费者仍会受到影响。
