---
title: 事件
description: 带类型的事件，处理函数归注册它的插件所有。
---

事件是一个带类型的标识，类型规定了参数、每个处理函数的返回值，以及处理函数可能产生的错误：

```ts
import { Event } from "@graftland/graft"

// Handlers take a message and return nothing.
const Message = Event.make<[text: string]>("app/message")

// Handlers take a command and may answer it.
const Command = Event.make<[name: string], Option.Option<string>>("app/command")
```

## 处理事件

`Event.on` 注册一个处理函数，在当前 `Scope` 关闭时移除。在 `apply`
内注册时，它会一直保留到插件停止：

```ts
const logger = Plugin.make({
	name: "logger",
	apply: () => Event.on(Message, (text) => Effect.log(text)),
})
```

处理函数使用注册时的上下文运行，而不是派发事件时的上下文。因此，它能访问的是自身插件的服务、领域（realm）和 intercept。

| 选项      | 作用                                       |
| --------- | ------------------------------------------ |
| `prepend` | 排在之前注册的处理函数前面执行。           |
| `global`  | 接收来自所有领域的事件，并忽略派发过滤器。 |

`Event.once`
注册一个最多执行一次的处理函数。它会在执行前被移除，因此即使再次派发同一个事件，也不会重复执行。

## 派发事件

| 函数              | 调用方式       | 结果                                            |
| ----------------- | -------------- | ----------------------------------------------- |
| `Event.emit`      | 依次调用       | 遇到第一个失败就停止。                          |
| `Event.parallel`  | 并发调用       | 收集所有结果，将所有失败合并到一个 `Cause` 中。 |
| `Event.bail`      | 依次调用       | 返回处理函数给出的第一个 `Some`。               |
| `Event.waterfall` | 按中间件链调用 | 返回整条链的输出。                              |

```ts
const status = Effect.gen(function* () {
	yield* Event.emit(Message, "Hello")
	const answer = yield* Event.bail(Command, "status")
	return Option.getOrElse(answer, () => "Nobody answered")
})
```

派发过程中被移除的处理函数，之后不会再被调用。如果处理函数正在运行时其所属插件停止，处理函数会被中断，派发则继续，就像它从未注册过一样。

### 中间件

`Event.middleware` 定义一种事件，其处理函数可以逐层包裹。每个处理函数接收输入和
`next`，可以修改输入、修改输出，或直接返回而不调用 `next`。`waterfall` 使用
`last` 作为链的末端：

```ts
const Render = Event.middleware<string, string>("app/render")

const render = Effect.gen(function* () {
	yield* Event.on(Render, (input, next) =>
		Effect.map(next(input.trim()), (output) => `<p>${output}</p>`),
	)
	// "<p>HI</p>"
	return yield* Event.waterfall(Render, "  hi  ", (input) =>
		Effect.succeed(input.toUpperCase()),
	)
})
```

每个处理函数最多只能调用一次 `next`，调用两次会产生缺陷（defect）。

## 领域与过滤器

事件和服务使用相同的[领域](../isolation/)机制。派发事件时，只有在该事件所属领域内注册的处理函数会被调用。将事件加入 fork 的
`isolate` 选项，就能为这部分插件树设置独立的处理函数。

需要更细致的控制时，可以用 `Event.filtered`
为派发添加过滤器。过滤器会收到每个处理函数注册时的上下文，可以检查其中的任何服务或 Reference：

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

以 `global: true` 注册的处理函数不受领域和过滤器限制。
