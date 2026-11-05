---
title: Events
description:
  Typed events with handlers that belong to the plugin that registered them.
---

An event is a typed token. Its type fixes three things:

- The arguments of a dispatch.
- The result of each handler.
- The errors that handlers may fail with.

```ts title="events.ts"
import { Option } from "effect"

import { Event } from "@graftland/graft"

// Handlers take a message and return nothing.
export const Message = Event.make<[text: string]>("app/message")

// Handlers take a command and may answer it.
export const Command = Event.make<[name: string], Option.Option<string>>(
	"app/command",
)
```

## Handle an event

`Event.on` registers a handler until the current scope closes. Inside `apply`,
that means until the plugin stops:

```ts import.meta.vitest name="events: handle an event"
import { Effect, Ref } from "effect"

import { Event, Graft, Plugin } from "@graftland/graft"

import { Message } from "./events.ts"

const heard = await Effect.runPromise(
	Effect.gen(function* () {
		const texts = yield* Ref.make<ReadonlyArray<string>>([])
		const listener = Plugin.make({
			name: "listener",
			apply: () =>
				Event.on(Message, (text) => Ref.update(texts, (all) => [...all, text])),
		})
		const fork = yield* Graft.plugin(listener)
		yield* fork.await
		yield* Event.emit(Message, "Hello")
		yield* fork.dispose
		yield* Event.emit(Message, "Bye")
		return yield* Ref.get(texts)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
heard // => ["Hello"]
```

### Options

| Option    | What it does                                                       |
| --------- | ------------------------------------------------------------------ |
| `prepend` | Runs before the handlers registered earlier.                       |
| `global`  | Receives the event from every realm, and ignores dispatch filters. |

### Handler context

A handler runs with the context of the code that registered it, not the code
that dispatched the event.

- **What it sees.** Its own plugin's services, realm and intercepts.
- **Scope per call.** Each call gets its own `Scope`, which Graft installs after
  it restores that context. Concurrent calls have independent scopes.
- **What the scope owns.** Resources the handler acquires, scoped fibers and
  child forks belong to that call. Graft releases them when the call completes,
  after any cancellation cleanup has finished.
- **Longer-lived resources.** Acquire them in the activation's `apply` before
  you register the handler, and capture them in its closure.

### `Event.once`

`Event.once` registers a handler that runs at most once.

- Graft removes it before it runs, so it does not run again, even if it
  dispatches the same event.
- The running handler stays owned until its execution and cancellation cleanup
  finish. Then Graft releases its registration; it does not wait for the owner's
  scope to close.

## Dispatch an event

| Function          | Calls handlers           | Result                                              |
| ----------------- | ------------------------ | --------------------------------------------------- |
| `Event.emit`      | One after another        | Stops at the first failure.                         |
| `Event.parallel`  | All at once              | Every result; all failures combined in one `Cause`. |
| `Event.bail`      | One after another        | The first `Some` a handler returns.                 |
| `Event.waterfall` | As a chain of middleware | The output of the chain.                            |

```ts import.meta.vitest name="events: dispatch an event"
import { Effect, Option } from "effect"

import { Event, Graft } from "@graftland/graft"

import { Command } from "./events.ts"

const status = Effect.gen(function* () {
	yield* Event.on(Command, () => Effect.succeedNone)
	yield* Event.on(Command, (name) => Effect.succeedSome(`${name}: running`))
	yield* Event.on(Command, () => Effect.succeedSome("never asked"))
	return yield* Event.bail(Command, "status")
})

await Effect.runPromise(status.pipe(Effect.scoped, Effect.provide(Graft.layer))) // => Option.some("status: running")
```

### Removal and cancellation during dispatch

| Situation                                   | Result                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A handler is removed during dispatch        | It is not called afterwards.                                                                                                                            |
| The handler's owner stops                   | The interruption skips the handler.                                                                                                                     |
| A handler interrupts itself or is cancelled | Its full `Cause` goes through the dispatch, and so do cleanup defects.                                                                                  |
| `Event.parallel` is cancelled               | It waits for the cleanup of every call, then combines the interruption with the failures and defects that already happened, including cleanup failures. |

If release of a framework-owned Scope is interrupted, Graft reports a
`ReleaseInterrupted` defect whose `cause` retains the original interruption.
This keeps release failures visible through nested events and background tasks;
ordinary cancellation remains an interruption.

## Middleware

`Event.middleware` defines an event whose handlers wrap each other. Each handler
receives the input and `next`, and may:

- change the input,
- change the output, or
- answer without calling `next`.

`waterfall` ends the chain with `last`:

```ts import.meta.vitest name="events: middleware"
import { Effect, String } from "effect"

import { Event, Graft } from "@graftland/graft"

const Render = Event.middleware<string, string>("app/render")

const render = Effect.gen(function* () {
	yield* Event.on(Render, (input, next) =>
		Effect.map(next(String.trim(input)), (output) => `<p>${output}</p>`),
	)
	return yield* Event.waterfall(Render, "  hi  ", (input) =>
		Effect.succeed(String.toUpperCase(input)),
	)
})

await Effect.runPromise(render.pipe(Effect.scoped, Effect.provide(Graft.layer))) // => "<p>HI</p>"
```

### Where each part runs

| Part                  | Context it runs with                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Registered middleware | Its registration context.                                                                     |
| The `last` callback   | The dispatcher's: services, references and log annotations captured when `waterfall` started. |

For `last`:

- It gets a fresh invocation `Scope`, whether or not middleware is present, so
  it may acquire scoped resources without the dispatcher providing a scope.
- Its resources close after its execution and cancellation cleanup, before
  control returns to the calling middleware.
- Middleware resources stay alive while it awaits `next` and processes the
  result.
- Adding middleware, or providing values around `next`, does not change the
  context of `last`.
- Only the context is restored. Execution does not move to a different fiber,
  and downstream work is not detached from cancellation.

### The `next` function

The `next` of each step executes downstream once.

- Its first execution selects the input. Later executions, including concurrent
  ones, share the same success, failure or interruption.
- A skipped handler continues through that same `next`.
- Unloading a handler's owner never replays downstream work that already ran.
- If the first downstream execution was interrupted, later calls get that
  interruption instead of starting again.

## Realms and filters

Events use the same [realms](../isolation/) as services. A dispatch reaches the
handlers that were registered in its own realm for that event. Put the event in
a fork's `isolate` option to give that part of the tree its own handlers.

For finer control, `Event.filtered` adds a filter to a dispatch. The filter
receives the context that each handler was registered in, so it can check any
service or reference there:

```ts import.meta.vitest name="events: filter a dispatch"
import { Context, Effect, Ref } from "effect"

import { Event, Graft } from "@graftland/graft"

import { Message } from "./events.ts"

const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

const formalOnly = Event.emit(Message, "Hello").pipe(
	Event.filtered((owner) => Context.get(owner, Formal)),
)

const heard = await Effect.runPromise(
	Effect.gen(function* () {
		const names = yield* Ref.make<ReadonlyArray<string>>([])
		const listen = (name: string) =>
			Event.on(Message, () => Ref.update(names, (all) => [...all, name]))
		yield* listen("casual")
		yield* listen("formal").pipe(Effect.provideService(Formal, true))
		yield* formalOnly
		return yield* Ref.get(names)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
heard // => ["formal"]
```

Handlers registered with `global: true` skip both realms and filters.
