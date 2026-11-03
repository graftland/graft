---
title: Events
description:
  Typed events with handlers that belong to the plugin that registered them.
---

An event is a typed token. Its type fixes the arguments, the result of each
handler, and the errors handlers may fail with:

```ts
import { Event } from "@graftland/graft"

// Handlers take a message and return nothing.
const Message = Event.make<[text: string]>("app/message")

// Handlers take a command and may answer it.
const Command = Event.make<[name: string], Option.Option<string>>("app/command")
```

## Handle an event

`Event.on` registers a handler until the current scope closes. Inside `apply`,
that is until the plugin stops:

```ts
const logger = Plugin.make({
	name: "logger",
	apply: () => Event.on(Message, (text) => Effect.log(text)),
})
```

A handler runs with the context of the code that registered it, not the code
that dispatched the event. It sees its own plugin's services, realm and
intercepts.

| Option    | What it does                                                       |
| --------- | ------------------------------------------------------------------ |
| `prepend` | Runs before the handlers registered earlier.                       |
| `global`  | Receives the event from every realm, and ignores dispatch filters. |

`Event.once` registers a handler that runs at most once. It is removed before it
runs, so it does not run again even if it dispatches the same event.

## Dispatch an event

| Function          | Calls handlers           | Result                                              |
| ----------------- | ------------------------ | --------------------------------------------------- |
| `Event.emit`      | One after another        | Stops at the first failure.                         |
| `Event.parallel`  | All at once              | Every result; all failures combined in one `Cause`. |
| `Event.bail`      | One after another        | The first `Some` a handler returns.                 |
| `Event.waterfall` | As a chain of middleware | The output of the chain.                            |

```ts
const status = Effect.gen(function* () {
	yield* Event.emit(Message, "Hello")
	const answer = yield* Event.bail(Command, "status")
	return Option.getOrElse(answer, () => "Nobody answered")
})
```

A handler that is removed while a dispatch runs is not called afterwards. If its
plugin stops while the handler is running, the handler is interrupted and the
dispatch goes on as if it had not been registered.

### Middleware

`Event.middleware` defines an event whose handlers wrap each other. Each handler
receives the input and `next`, and may change the input, change the output, or
answer without calling `next`. `waterfall` ends the chain with `last`:

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

A handler may call `next` at most once. Calling it twice is a defect.

## Realms and filters

Events use the same [realms](../isolation/) as services. A dispatch reaches the
handlers registered in its own realm for that event. Put the event in a fork's
`isolate` option to give that part of the tree its own handlers.

For finer control, `Event.filtered` adds a filter to a dispatch. The filter
receives the context each handler was registered in, so it can check any service
or reference there:

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

Handlers registered with `global: true` skip both realms and filters.
