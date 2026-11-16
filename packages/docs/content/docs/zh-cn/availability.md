---
title: 服务可用性
description: 在服务已发布时读取它，并在撤回时停止工作。
---

服务可以在应用运行期间出现和消失。四个操作无需挂载 Layer，就能从图里读取服务并对这种变化做出反应。

| 操作                           | 结果                     | 服务被撤回时                         |
| ------------------------------ | ------------------------ | ------------------------------------ |
| `Graft.watch(key)`             | `Stream<Option<S>>`      | 发出 `Option.none()`                 |
| `Graft.await(key)`             | 服务发布后的 `Effect<S>` | 下一次读取可能找不到它               |
| `Graft.use(key, f)`            | 带着值运行一次 `f`       | 中断 `f`，以 `ServiceWithdrawn` 失败 |
| `Graft.whileAvailable(key, f)` | 每个值都运行一次 `f`     | 中断 `f`，等下一个值再运行           |

这些操作读取图里发布的服务。它们看不到只存在于构建 `Graft.layer`
时的环境里的服务。

## 观察一个服务

```ts
import { Context, Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const regions = Graft.watch(Region).pipe(
	Stream.map((region) => (region._tag === "Some" ? region.value : "none")),
)
```

`watch` 先立即发出当前的可用性，可能是
`None`；此后每当前 provision 的身份变化，就发一帧。它持有一个槽位，所以没有值时身份也不会丢失。用它显示状态，或对配置变化做出反应。

## 用一次服务做一件事

`Graft.use`
等待服务、持有租约，然后运行你的 effect。如果服务先被撤回，effect 被中断，`use`
以 `Graft.ServiceWithdrawn` 失败。

```ts import.meta.vitest name="availability: use a published service"
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		return yield* Graft.use(Region, (region) => Effect.succeed(`in ${region}`))
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "in eu"
```

租约让撤回等待：持有它的服务的每个 `use`
都完成之前，提供者不会被拆除。需要该服务的挂载同样适用。

## 在服务可用期间运行

`Graft.whileAvailable` 为每个发布的值启动一次 `f`。撤回会中断
`f`；服务再次发布时，`f` 用新的值再运行一次。

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const program = Graft.whileAvailable(Region, (region) =>
	Effect.log(`Serving ${region}`),
)
```

| 如果 `f`…… | 那么                                   |
| ---------- | -------------------------------------- |
| 完成       | 它等待下一个值。                       |
| 失败       | `whileAvailable` 以该错误失败并停止。  |
| 被撤回     | 它被中断，下一次值到来时开始新的一轮。 |

## 等待一个服务

`Graft.await`
等到服务被发布并返回它。它之后不再持有服务：调用返回后，服务可能马上被撤回。需要让工作保住服务时，用
`use` 或 `whileAvailable`。

## 选择操作

| 我想……                 | 使用                           |
| ---------------------- | ------------------------------ |
| 显示服务是否存在       | `watch`                        |
| 读一个值然后放掉       | `await`                        |
| 做一件需要该服务的任务 | `use`                          |
| 只要它存在就一直做下去 | `whileAvailable`               |
| 构建需要该服务的 Layer | 带 `requires` 的 `Graft.mount` |

挂载通过 `requires` 和租约获得同样的保证；见[生命周期](../lifecycle/)。
