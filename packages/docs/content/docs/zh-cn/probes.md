---
title: 健康探针
description: 为服务尝试注册检查，并显式请求执行。
---

**探针**是在 `apply` 中通过 `Plugin.probe`
注册的具名 Effect。注册不会执行检查。每次服务尝试拥有自己的注册及正在运行的检查。

## 注册和请求探针

```ts import.meta.vitest name="probes: request a check"
import { Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const program = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const plugin = Plugin.make({
		name: "app/integration",
		apply: () =>
			Plugin.probe(
				"upstream",
				Ref.update(calls, (n) => n + 1),
			),
	})
	const fork = yield* Graft.plugin(plugin)
	yield* fork.await
	yield* Ref.get(calls) // => 0
	yield* fork.probes // => ["upstream"]
	yield* fork.probe("upstream")
	yield* Ref.get(calls) // => 1
})
await Effect.runPromise(
	program.pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

| 规则       | 行为                                                               |
| ---------- | ------------------------------------------------------------------ |
| 归属       | 注册持续到注册时的 scope 关闭。重启会注册新的检查。                |
| 隔离       | 不同 fork 可以使用相同名称。同一次尝试中重复注册会失败。           |
| 上下文     | 检查使用注册时捕获的服务。每次请求都有自己的 scope。               |
| 失败       | `Fork.ProbeError` 保留检查的完整 cause。检查失败不会自动重启插件。 |
| 取消       | 关闭注册 scope 会中断正在运行的检查。中断请求会取消该次调用。      |
| 检查不存在 | 请求未注册的名称会得到 reason 为 `Missing` 的 `ProbeError`。       |

## 远程检查

Remote 执行单元通过控制通道接受探针请求。描述实现不会运行 `apply`
或探针。开始服务会运行普通的
`apply`；就绪检查等待插件及其导出的服务就绪。探针成功、服务就绪和进程确认退出是不同的事实。

`fork.probe`
访问嵌入式运行时中该 fork 自己的注册。Change 会在新代开始服务前、以及对恢复的代，运行各插件在
`deployment` 导出中声明的探针（在插件旁写
`export const deployment = { probes: ["health"] }`），以及 `requirements.probes`
中列出的探针。探针失败时 Change 中止或恢复，并在结局中保留其 cause。参阅[变更](../transitions/#请求字段)。
