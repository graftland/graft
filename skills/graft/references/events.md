# Events

An event is a typed token. Its type fixes the dispatch arguments, each handler's
result and the errors handlers may fail with.

```ts
import { Event } from "@graftland/graft"
import { Option } from "effect"

export const Message = Event.make<[text: string]>("@acme/chat/message")
export const Command = Event.make<[name: string], Option.Option<string>>(
	"@acme/chat/command",
)
export const Render = Event.middleware<string, string>("@acme/chat/render")
```

Export tokens from a shared module; emitters and handlers both import them.

## Handle

```ts
const logger = Plugin.make({
	name: "logger",
	apply: () => Event.on(Message, (text) => Effect.log(text)),
})
```

- The handler stays registered until the current scope closes: inside `apply`,
  until the plugin stops.
- Options: `prepend` runs before earlier handlers; `global` receives the event
  from every realm and ignores filters.
- `Event.once` runs at most once.
- A handler runs with **its own plugin's** services, realm and intercepts, not
  the dispatcher's. Each call gets a fresh `Scope`; resources it acquires are
  released when the call ends. Acquire longer-lived resources in `apply` and
  capture them in the closure.

## Dispatch

| Function                              | Calls handlers    | Result                                          |
| ------------------------------------- | ----------------- | ----------------------------------------------- |
| `Event.emit(Token, ...args)`          | One after another | Waits for all; stops at the first failure.      |
| `Event.parallel(Token, ...args)`      | All at once       | Every result; failures combined in one `Cause`. |
| `Event.bail(Token, ...args)`          | One after another | The first `Some` a handler returns.             |
| `Event.waterfall(Token, input, last)` | As middleware     | The output of the chain.                        |

```ts
const status = Effect.gen(function* () {
	yield* Event.emit(Message, "Hello")
	const answer = yield* Event.bail(Command, "status")
	return Option.getOrElse(answer, () => "Nobody answered")
})
```

Dispatch waits for handlers. For fire-and-forget, dispatch inside a
`Plugin.fork` task.

## Middleware

Each `Event.middleware` handler receives `(input, next)` and may change the
input, change the output, or answer without calling `next`. `last` ends the
chain and runs with the dispatcher's context.

```ts
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

`next` runs downstream once; later calls share its result.

## Choose an event or a service

| Need                                                 | Use              |
| ---------------------------------------------------- | ---------------- |
| Many plugins react; the sender does not know them    | Event            |
| One provider answers; consumers wait until it exists | Service          |
| A pipeline of transformations contributed by plugins | Middleware event |

## Realms and filters

A dispatch reaches handlers registered in its own realm; put the token in a
fork's `isolate` option to give a subtree its own handlers
([realms](realms.md)). `Event.filtered` selects handlers by their registration
context:

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```
