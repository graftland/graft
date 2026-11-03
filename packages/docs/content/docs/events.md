---
title: Events
description:
  Typed events with handlers that belong to the plugin that registered them.
---

An event is a typed token. Its type fixes the arguments, the result of each
handler, and the errors that handlers may fail with:

```ts
import { Event } from "@graftland/graft"

// Handlers take a message and return nothing.
const Message = Event.make<[text: string]>("app/message")

// Handlers take a command and may answer it.
const Command = Event.make<[name: string], Option.Option<string>>("app/command")
```

## Handle an event

`Event.on` registers a handler until the current scope closes. Inside `apply`,
that means until the plugin stops:

```ts
const logger = Plugin.make({
	name: "logger",
	apply: () => Event.on(Message, (text) => Effect.log(text)),
})
```

A handler runs with the context of the code that registered it, not the code
that dispatched the event. It sees its own plugin's services, realm, and
intercepts. Each call gets its own `Scope`, which Graft installs after it
restores that context. Resources that a handler acquires, scoped fibers, and
child forks belong to that call. Graft releases them when the call completes,
after any cancellation cleanup has finished. Concurrent calls have independent
scopes. Some resources must live across calls. Acquire them in the activation's
`apply` before you register the handler, and capture them in its closure.

| Option    | What it does                                                       |
| --------- | ------------------------------------------------------------------ |
| `prepend` | Runs before the handlers registered earlier.                       |
| `global`  | Receives the event from every realm, and ignores dispatch filters. |

`Event.once` registers a handler that runs at most once. Graft removes it before
it runs, so it does not run again, even if it dispatches the same event. The
running handler stays owned until its execution and cancellation cleanup finish.
Then Graft releases its registration. It does not wait for the owner's scope to
close.

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

A handler that is removed during dispatch is not called afterwards. If the
handler's owner stops, the interruption skips the handler. A handler that
interrupts itself, or is cancelled for another reason, sends its full Cause
through the dispatch. Cleanup defects also go through. Cancelling
`Event.parallel` waits for the cleanup of every call. Then it combines the
interruption with the failures and defects that already happened, including
cleanup failures.

### Middleware

`Event.middleware` defines an event whose handlers wrap each other. Each handler
receives the input and `next`. It may change the input, change the output, or
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

Registered middleware runs with its registration context. The `last` callback
belongs to the dispatcher. It uses the services, references, and log annotations
that were captured when `waterfall` started. It also gets a fresh invocation
`Scope`, whether or not middleware is present. So it may acquire scoped
resources, and the dispatcher does not need to give it a scope. Its resources
close after its execution and cancellation cleanup, before control returns to
the calling middleware. Middleware resources stay alive while it awaits `next`
and processes the result. Adding middleware, or providing values around `next`,
does not change the context of `last`. This restores the context only. It does
not move execution to a different fiber, and it does not detach downstream work
from cancellation.

The `next` of each step executes downstream once. Its first execution selects
the input. Later executions, including concurrent ones, share the same success,
failure, or interruption. A skipped handler continues through that same `next`.
Unloading a handler's owner never replays downstream work that already ran. If
the first downstream execution was also interrupted, later calls get that
interruption. They do not start again.

## Realms and filters

Events use the same [realms](../isolation/) as services. A dispatch reaches the
handlers that were registered in its own realm for that event. Put the event in
a fork's `isolate` option to give that part of the tree its own handlers.

For finer control, `Event.filtered` adds a filter to a dispatch. The filter
receives the context that each handler was registered in. So it can check any
service or reference there:

```ts
const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)
```

Handlers registered with `global: true` skip both realms and filters.
