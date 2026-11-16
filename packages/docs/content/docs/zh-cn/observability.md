---
title: 可观测性
description: 跟随挂载树，并读取 Graft 收集的日志。
---

Graft 用两条流暴露图：挂载树和日志。

## 挂载树

`Graft.mounts`
在图每次变化时发出整棵树。每个节点带有挂载的 ID、名称、当前状态和子节点。

```ts import.meta.vitest name="observability: read the mount tree"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const greeting = Layer.effect(Greeting, Effect.succeed("hello"))

const tree = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, { name: "greeting" })
		yield* mount.await
		return yield* Stream.runHead(Graft.mounts)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
tree // => Option.some([{ id: 1, name: "greeting", state: Mount.MountState.Active(), children: [] }])
```

| 字段       | 用途                                  |
| ---------- | ------------------------------------- |
| `id`       | 在日志和错误里标识这个挂载。          |
| `name`     | `name` 选项；没有设置时为 `"layer"`。 |
| `state`    | 与挂载句柄暴露的状态相同。            |
| `children` | 在这个挂载的 Layer 里创建的挂载。     |

把这棵树发给状态页、健康检查端点或调试日志。一次重建会发出带有新状态的新树。

## 日志

`Graft.logs` 收集使用 `Graft.layer`
的环境里的日志，包括宿主应用和每个挂载的日志。

| 行为     | 说明                                                           |
| -------- | -------------------------------------------------------------- |
| 重放     | 新的订阅者先收到最近 1000 条。                                 |
| 注解     | 挂载构建或运行期间写的日志带有 `graft.mount` 和 `graft.name`。 |
| 宿主日志 | 保留自己的注解；挂载相关的注解可能不存在。                     |
| 级别     | 级别、消息、`Cause` 和注解都完整保留。                         |

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const recent = Graft.logs.pipe(
	Stream.map((entry) => ({
		level: entry.level,
		message: entry.message,
		mount: entry.annotations["graft.mount"],
	})),
)
```

只取需要的部分，避免永远订阅下去：

```ts
import { Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

export const errors = Stream.runCollect(
	Stream.filter(Graft.logs, (entry) => entry.level === "Error").pipe(
		Stream.take(10),
	),
).pipe(Effect.map((entries) => entries.length))
```

## 追踪

每次构建和每个运行中的挂载都是一个名为 `graft.mount <name>`
的 span。这个 span 包住 Layer 的构建以及它做的工作，所以你自己的 span 出现在它下面。日志注解使用同样的名字，让一次缓慢的构建和它的日志在追踪查看器里保持在一起。

## 该看什么

| 症状         | 到哪里看                                        |
| ------------ | ----------------------------------------------- |
| 挂载从不启动 | `state` 显示 `Pending`，并列出缺少的键。        |
| 挂载反复重建 | `state` 的变化，以及其间的日志行。              |
| 挂载失败     | `state` 显示 `Failed`；在日志里读它的 `cause`。 |
| 拆除很慢     | 关于消费者仍在等待的那条警告。                  |
