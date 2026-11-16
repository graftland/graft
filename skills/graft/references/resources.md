# Resources, background work and release

A mount owns everything it acquires. The discipline is to give every resource
and fiber an owner and a scope, and to let Graft close that scope at the right
moment.

## Resources

Acquire resources with `Effect.acquireRelease` inside the layer. The release
finalizer runs when the mount is torn down — after every consumer below it has
finished:

```ts
const poolLayer = Layer.scoped(
	Pool,
	Effect.acquireRelease(openPool(config), (pool) => pool.close()),
)
```

- The release runs in the mount's scope, so it may still use services the mount
  published.
- Long cleanup delays teardown; keep finalizers bounded.
- A failing finalizer fails the unmount with `CleanupError`, preserving the
  original `Cause`.

## Background work

Work that must outlive the current fiber, but not the mount, goes through
`Graft.fork`:

```ts
const worker = Effect.gen(function* () {
	yield* Graft.fork(
		Effect.forever(Effect.andThen(Clock.sleep("1 minute"), refresh)),
	)
})
```

- The fiber is interrupted when the mount is torn down.
- A failure fails the mount; add `retry` on the mount to rebuild it.
- `Effect.forkScoped` also ties a fiber to the mount's scope, but its failure
  does not fail the mount. Use `Graft.fork` when the failure matters.

## Retries

`retry` rebuilds a failed mount on a schedule:

```ts
const mounted = Effect.gen(function* () {
	yield* Graft.mount(flakyLayer, {
		retry: Schedule.exponential("1 second").pipe(Schedule.jittered),
	})
})
```

- The schedule applies to a whole build attempt, not to one effect inside it.
- Without `retry`, a failed mount waits for a requirement to change.
- Test retries with `TestClock` by providing `TestContext`.

## Releasing scopes safely: `Release`

Ordinary `Scope.close` can lose a release interrupted by an enclosing
cancellation: the finalizer's work is discarded and the cancellation looks like
the only cause. The `Release` module keeps them distinct:

```ts
import { Release } from "@graftland/graft"

const main = Effect.gen(function* () {
	yield* Release.scoped(program) // run with its own scope, closed safely
	yield* Release.close(scope, exit) // close an existing scope safely
})
```

| Member               | Use                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `Release.scoped(f)`  | Run `f` in a fresh scope and close it with `Release.close`.                                      |
| `Release.close`      | Close a scope; interrupted finalizers become a `ReleaseInterrupted` defect carried in the cause. |
| `ReleaseInterrupted` | The release itself was interrupted; its `cause` holds the interrupts.                            |

- Real failures in the release stay as they are, combined with the body's cause.
- A release that is only interrupted (not cancelled) is reported as
  `ReleaseInterrupted`, so it is not silently swallowed.
- Use these when you manage scopes yourself; mounts already release safely.

## Timers and clocks

Use `Clock` for time and `Schedule` for delays. Under `TestClock` they advance
on demand, so tests do not wait in real time.
