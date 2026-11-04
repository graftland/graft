# Tests

cordis tests build a `new Context()`, load plugins, `await` fibers, and assert
on mocks. Graft tests are Effects run by `@effect/vitest`, each with a fresh
Graft runtime.

## Skeleton

```ts
import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Effect, Layer, Stream } from "effect"
import plugin from "../src/index.ts"

describe("greeter", () => {
	it.effect("greets once the database exists", () =>
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
  failures surface in the test.

## Translating cordis test idioms

| cordis                                         | Graft                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `const root = new Context()`                   | `Effect.provide(Layer.fresh(Graft.layer))`                                                         |
| `await root.plugin(p, config)`                 | `const fork = yield* Graft.plugin(p, input)` then `yield* fork.await`                              |
| Waiting for `ACTIVE`                           | `Stream.runHead(Stream.filter(fork.state, (s) => s._tag === "Active"))`                            |
| `expect(fiber.state).toBe(FiberState.PENDING)` | Read the head of `fork.state` and compare `_tag`                                                   |
| `await fiber.dispose()`                        | `yield* fork.dispose`                                                                              |
| A mock service registered with `ctx.provide`   | A test plugin that calls `Graft.provide(Key, fake)`, or a `Layer` merged into the test environment |
| `vi.fn()` call counts                          | A `Ref` or journal service that records calls                                                      |
| `vi.useFakeTimers()`                           | `TestClock.adjust` (provided by `it.effect`)                                                       |
| `await new Promise(setImmediate)`              | `Deferred` handshakes between the test and the plugin                                              |
| Checking logged errors                         | Collect `Graft.logs` and assert on entries                                                         |
| `expect(...).rejects`                          | `Effect.exit` / `Effect.flip` and assert on the `Exit` or error                                    |

Prefer `Deferred` handshakes over yield loops: a test that waits on an explicit
signal does not depend on scheduling.

## What to keep

- Every scenario of the cordis suite, including lifecycle races. Graft's own
  suite replays cordis issue reproductions, and many races cordis needed a test
  for are now guaranteed; keep the test anyway as proof.
- Assertions on order (consumer stopped before provider closed) as recorded
  journals, not timing.
