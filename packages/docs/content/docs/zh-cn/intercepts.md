---
title: Intercept
description: 为某个挂载及其下所有挂载调整一个 Context.Reference。
---

**intercept** 为某个挂载改变一个 `Context.Reference`
的值。该挂载及其下的 Layer 和子挂载读到调整后的值，应用的其余部分保持原值。

## 拦截一个 Reference

```ts import.meta.vitest name="intercepts: adjust a reference"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const Prefix = Context.Reference<string>("app/Prefix", {
	defaultValue: () => "Hello",
})

const greeting = Layer.effect(
	Greeting,
	Effect.map(Prefix, (prefix) => `${prefix}, world`),
)

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, {
			name: "greeting",
			requires: [Prefix],
			intercept: [Graft.intercept(Prefix, (prefix) => `${prefix}!`)],
		})
		yield* mount.await
		return yield* Graft.await(Greeting)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "Hello!, world"
```

`Graft.intercept`
接收 Reference 和一个把外层值变成新值的函数。同一个 Reference 的多个 intercept 由内向外应用：列表里靠后的那个看到的是前面几个的结果。

## 拦截到达哪里

| 到达                             | 不到达                 |
| -------------------------------- | ---------------------- |
| 挂载自身的构建                   | 兄弟挂载               |
| 它的后台 fiber                   | 它的父挂载             |
| 每个子挂载及其子挂载             | 另一个领域里发布的服务 |
| 通过 `requires` 读取的 Reference | 非 Reference 的服务    |

intercept 随创建挂载时的上下文传递，所以子挂载在继承来的值之上叠加自己的 intercept。

## 解析顺序

对于 `requires` 里的 Reference，值按以下顺序解析：

1. 挂载所在领域里发布的值。
2. 继承来的 Reference 值，包括 intercept。
3. Reference 的默认值。

Reference 总有回落值，所以它不会让挂载停在
`Pending`。发布仍然优先，该值出现或消失时挂载重建。直接读取值的方式见[服务可用性](../availability/)。

## 何时使用 intercept

| 用 intercept 来……            | 用发布来……               |
| ---------------------------- | ------------------------ |
| 给一个子树不同的设置         | 改变整个应用的值         |
| 为某个租户收窄超时或特性开关 | 从文件读取配置           |
| 调整库已经在读取的 Reference | 提供一个原本不存在的服务 |

如果目标是一个独立的提供者而不是不同的 Reference 值，用[隔离](../isolation/)。
