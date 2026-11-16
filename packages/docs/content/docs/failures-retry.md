---
title: Failures and retries
description:
  Read a failed mount's cause, choose a retry schedule, and know which errors
  mean what.
---

A mount that fails does not disappear. It enters `Failed`, keeps the complete
`Cause`, and waits for a change or for its retry schedule.

## Read a failure

`mount.await` fails with the mount's error; `mount.state` emits a `Failed` state
that carries the same `Cause`.

```ts import.meta.vitest name="failures-retry: a failed build keeps its cause"
import { Context, Effect, Exit, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const failed = Layer.effect(Greeting, Effect.fail("no greeting"))

const failure = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(failed, { name: "greeting" })
		return yield* Effect.exit(mount.await)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
Exit.isFailure(failure) // => true
```

The cause keeps typed errors, defects and interruption reasons. Cleanup failures
join the same cause, so you never lose a finalizer that failed while the layer
was being torn down.

## A cleanup defect turns the startup failure into a defect

When a layer's build fails and a finalizer in the same build's cleanup ends with
a defect, Effect reclassifies the build's typed failure as a defect, as
`Effect.scoped` does. In the mount's `Failed` cause the startup error therefore
appears as a `Die`, and `catchTag` cannot match it.

| Situation                               | How the startup error appears in the cause |
| --------------------------------------- | ------------------------------------------ |
| The build fails, cleanup succeeds       | `Fail`, keeping the layer's typed error    |
| The build fails and a finalizer defects | `Die`, so `catchTag` does not match it     |

To keep a typed startup error, end finalizers with a typed failure or without
failing.

## Retry a failed mount

Pass an Effect `Schedule` as `retry` to rebuild after a failure:

```ts
import { Context, Effect, Layer, Schedule } from "effect"

import { Graft } from "@graftland/graft"

class Connection extends Context.Service<Connection, string>()(
	"app/Connection",
) {}

declare const connect: Effect.Effect<string, Error>

export const connection = Layer.effect(
	Connection,
	connect.pipe(Effect.retry(Schedule.exponential("1 second"))),
)

export const program = Graft.mount(connection, {
	name: "connection",
	retry: Schedule.exponential("1 second"),
})
```

| Situation                               | What happens                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| The build fails, a schedule is set      | The mount stays `Failed`, then retries on the schedule.                      |
| The build fails, no schedule is set     | The mount tries once, stays `Failed`, and waits for a change.                |
| The schedule asks for no delay          | Each next retry waits at least 1 ms, and that wait can be interrupted.       |
| The schedule asks for a delay           | The mount waits exactly that delay; nothing is added.                        |
| The mount is unmounted while it waits   | The wait is cancelled.                                                       |
| A requirement or the mount spec changes | The current retry is cancelled, and a new attempt starts after cleanup.      |
| Nothing changes                         | The schedule keeps its step and budget between attempts.                     |
| A publication conflict blocks the mount | Graft waits for the graph to change instead of retrying into the same cycle. |

A retry that fails again combines the new failure with the previous cause. The
mount remains observable and restartable throughout.

`mount.await` does not wait for the retry to succeed. It settles at the first
`Failed` and fails with that cause; the schedule keeps retrying in the
background. Use `state` to observe later attempts.

## Name the errors

| Error                        | Raised when                                                                               | What to do                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Graft.ServiceConflict`      | A service is already provided in the realm, or publishing would rebuild its own provider. | Read `reason`; see below.                                 |
| `Graft.ServiceWithdrawn`     | A value used by `Graft.use` was withdrawn while it was running.                           | Retry the work, or wait for the value with `watch`.       |
| `Mount.CleanupError`         | `unmount` or an automatic scope close hits failures while releasing resources.            | Read `cause`; it keeps the original failures and defects. |
| `Release.ReleaseInterrupted` | A finalizer interrupted itself while the surrounding release was being cancelled.         | Treat it as a defect; the `cause` keeps the interruption. |

### ServiceConflict

| `reason`          | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| _(none)_          | Another mount or publication already provides this key. |
| `SelfDependency`  | Publishing would rebuild the provider itself, directly. |
| `DependencyCycle` | The same, through other mounts.                         |
| `Invalidated`     | A dependency change already invalidated the provider.   |

The error also carries the service name, its realm and the mount ID that tried
to publish.

## Where a failure lands

| Source                             | Result                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| Building the layer                 | `Failed` with the build's cause.                       |
| A `Graft.fork` fiber failing       | `Failed` with the fiber's cause.                       |
| A resource finalizer failing       | Added to the cause of the teardown that ran it.        |
| A bare `Effect.forkScoped` failing | Reported through that fiber's scope, not to the mount. |

A failure starts the normal [teardown order](../lifecycle/#teardown-order).
Healthy background fibers keep serving consumers until their leases are
released.
