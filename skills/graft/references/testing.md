# Testing

Tests are Effects run by `@effect/vitest`, each with a fresh Graft runtime.

## Skeleton

```ts
import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Effect, Layer, Stream } from "effect"
import plugin from "../src/index.ts"

describe("greeter", () => {
	it.effect("starts once the database exists", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(plugin, { greeting: "Hello" })
			yield* fork.await
			// ...assertions
		}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
	)
})
```

- `Layer.fresh(Graft.layer)` gives each test its own registry.
- `Effect.scoped` unloads every plugin the test loaded, so teardown runs and its
  failures surface in the test. To assert on what teardown did, close an inner
  `Effect.scoped` first and assert after it.
- Add environment services the plugin needs with
  `Layer.provideMerge(Graft.layer, ...)`.

## Helpers

```ts
// The fork's current state tag.
const state = (fork: Fork.Fork) =>
	Effect.map(Stream.runHead(fork.state), (state) =>
		state._tag === "Some" ? state.value._tag : "Disposed",
	)

// Wait until the fork runs. `fork.await` returns already at `Pending`.
const running = (fork: Fork.Fork) =>
	Stream.runHead(Stream.filter(fork.state, (state) => state._tag === "Active"))
```

## Techniques

| To check…                       | Do                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------ |
| The fork waits for a service    | `fork.await`, then `state(fork)` is `"Pending"`                                |
| A dependency starts it          | Load a test plugin that calls `Graft.provide(Key, fake)`, then `running(fork)` |
| A failure                       | `Effect.exit(fork.await)` or `Effect.flip`, then assert on the error           |
| An update in place or a restart | `fork.update(input)`, then compare a counter or the logs                       |
| Teardown order                  | Record steps in a `Ref` or a journal service; assert on the sequence           |
| Calls to a dependency           | A fake service that records into a `Ref`                                       |
| Timers and retries              | `TestClock.adjust` (installed by `it.effect`)                                  |
| Concurrent steps                | `Deferred` handshakes between the test and the plugin                          |
| Log output                      | Collect `Graft.logs` and compare messages                                      |

Wait on an explicit signal (`Deferred`, `running`, a state) rather than yielding
in loops or sleeping, so the test does not depend on scheduling. With
`TestClock`, make sure the code under test has started its sleep before you
advance the clock.

## Collecting logs

```ts
const text = (entry: Graft.LogEntry) =>
	Array.join(
		Array.map(Array.ensure(entry.message), (part) => `${part}`),
		" ",
	)

const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => text(entry) === "end of log"),
	)
	return Array.dropRight(Array.map(entries, text), 1)
})
```

## Config-file and loader tests

Load `Loader.plugin` with entries and a
`ModuleResolver.fromRecord({ name: plugin })` resolver to test entries without
files; use `loader.ready` to wait for reconciliation. See
[apps](apps.md#embed-graft).
