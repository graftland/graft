---
title: 事件
description: 带类型的事件，处理函数归注册它的插件所有。
---

事件是一个带类型的标识，类型规定了三件事：

- 派发时的参数。
- 每个处理函数的返回值。
- 处理函数可能产生的错误。

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

### 选项

| 选项      | 作用                                       |
| --------- | ------------------------------------------ |
| `prepend` | 排在之前注册的处理函数前面执行。           |
| `global`  | 接收来自所有领域的事件，并忽略派发过滤器。 |

### 处理函数的上下文

处理函数使用注册它的代码的上下文，而不是派发事件的代码的上下文。

- **能看到什么。** 所属插件的服务、领域（realm）和 intercept。
- **每次调用的 Scope。** 恢复注册上下文后，Graft 会为每次调用安装独立的
  `Scope`。并发调用的 Scope 互不影响。
- **Scope 拥有什么。** 处理函数取得的资源、scoped
  fiber 和子 fork 归这次调用所有。Graft 在调用完成、取消清理结束后释放它们。
- **更长寿命的资源。** 应在 activation 的 `apply`
  中、注册处理函数之前取得，再由处理函数闭包引用。

### `Event.once`

`Event.once` 注册一个最多执行一次的处理函数。

- Graft 会在它执行前将其移除，因此即使它再次派发同一个事件，也不会重复执行。
- 运行中的处理函数仍保有归属，直到执行及取消清理完成；随后 Graft 释放该注册，无需等到 owner 的 Scope 关闭。

## 派发事件

| 函数              | 调用处理函数   | 结果                                            |
| ----------------- | -------------- | ----------------------------------------------- |
| `Event.emit`      | 依次调用       | 遇到第一个失败就停止。                          |
| `Event.parallel`  | 同时调用       | 收集所有结果，将所有失败合并到一个 `Cause` 中。 |
| `Event.bail`      | 依次调用       | 返回处理函数给出的第一个 `Some`。               |
| `Event.waterfall` | 按中间件链调用 | 返回整条链的输出。                              |

```ts
const status = Effect.gen(function* () {
	yield* Event.emit(Message, "Hello")
	const answer = yield* Event.bail(Command, "status")
	return Option.getOrElse(answer, () => "Nobody answered")
})
```

### 派发期间的移除与取消

| 情形                               | 结果                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| 处理函数在派发过程中被移除         | 之后不会再被调用。                                                        |
| 处理函数所属插件停止               | 该中断使处理函数被跳过。                                                  |
| 处理函数主动中断，或因其他原因取消 | 它完整的 `Cause` 会通过派发传播，清理产生的 defect 也会传播。             |
| 取消 `Event.parallel`              | 先等待所有调用清理完成，再将中断与已经发生的失败、defect 及清理失败合并。 |

框架管理的 Scope 在释放时发生纯中断，会以 `ReleaseInterrupted`
defect 报告，原始中断保存在它的 `cause`
中。这样，释放失败经过嵌套事件或后台任务仍能传到调用方；正常取消仍按中断处理。

## 中间件

`Event.middleware` 定义一种事件，其处理函数可以逐层包裹。每个处理函数接收输入和
`next`，可以：

- 修改输入，
- 修改输出，或
- 直接返回而不调用 `next`。

`waterfall` 使用 `last` 作为链的末端：

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

### 各部分的运行上下文

| 部分         | 使用的上下文                                                         |
| ------------ | -------------------------------------------------------------------- |
| 注册的中间件 | 注册时的上下文。                                                     |
| `last` 回调  | 派发者的上下文：`waterfall` 开始时捕获的服务、Reference 和日志注解。 |

对于 `last`：

- 无论有没有中间件，它都有全新的调用
  `Scope`，因此可以取得 scoped 资源，无需派发者提供 Scope。
- 它的资源在执行及取消清理结束后、控制权返回调用它的中间件之前关闭。
- 中间件在等待 `next` 及处理其结果期间，自身的资源仍然存活。
- 增加中间件或在 `next` 外提供值，都不会改变 `last` 的上下文。
- 这只恢复上下文，不切换执行 fiber，也不使下游脱离取消关系。

### `next` 函数

每一步的 `next` 只执行一次下游。

- 首次执行选择输入；之后的执行（包括并发执行）共享同一个成功、失败或中断结果。
- 如果处理函数被跳过，链条使用同一个 `next` 继续。
- 处理函数所属插件卸载后，已经执行过的下游不会重放。
- 如果首次下游执行被中断，之后的调用得到该中断结果，不会重新开始。

## 领域与过滤器

事件和服务使用相同的[领域](../isolation/)机制。派发事件时，只有在该事件自己的领域内注册的处理函数会被调用。将事件加入 fork 的
`isolate` 选项，就能为这部分插件树设置独立的处理函数。

需要更细致的控制时，可以用 `Event.filtered`
为派发添加过滤器。过滤器会收到每个处理函数注册时的上下文，因此可以检查其中的任何服务或 Reference：

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

以 `global: true` 注册的处理函数不受领域和过滤器限制。
