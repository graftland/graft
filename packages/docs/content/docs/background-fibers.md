---
title: Background fibers
description:
  Start work that belongs to a mount, and let its failure fail the mount.
---

A layer often starts work that outlives the build: a poller, a server, a
subscriber. `Graft.fork` starts such a fiber and gives it an owner.

## Fork work in a layer

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Events extends Context.Service<Events, string>()("app/Events") {}

export const events = Layer.effect(
	Events,
	Effect.gen(function* () {
		yield* Graft.fork(
			Effect.log("Subscribed").pipe(Effect.andThen(Effect.never)),
		)
		return "ready"
	}),
)
```

The fiber belongs to the mount that is building this layer. It is interrupted
when the mount is torn down, and its failure fails the mount.

| Behavior                 | Result                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Owner                    | The mount whose layer is running.                                                       |
| On teardown              | Interrupted after the mount's consumers have released their leases.                     |
| On failure               | The mount becomes `Failed` with the fiber's complete `Cause`, then follows its `retry`. |
| Pure interruption        | Does not fail the mount.                                                                |
| Error type               | Carried to the mount through `Graft.Tasks<E>` and `Graft.BackgroundError`.              |
| Bare `Effect.forkScoped` | Its lifetime follows the scope, but its failure does not reach the mount.               |

## Handle errors in the fiber

A fiber that fails takes the mount with it, so catch the errors you can recover
from inside it:

```ts
import { Effect, Schedule } from "effect"

import { Graft } from "@graftland/graft"

export const poll = Graft.fork(
	Effect.log("Polling").pipe(
		Effect.andThen(Effect.never),
		Effect.retry(Schedule.exponential("1 second")),
	),
)
```

The error types of a forked fiber are part of the layer's contract: a mount
whose layer forks an `Effect<never, HttpError>` can fail with `HttpError`, and
`mount.await` exposes it. See [failures and retries](../failures-retry/).

## After withdrawal

When a mount is torn down, its published services are withdrawn first, then its
consumers release their leases, and only then are the background fibers
interrupted. A consumer finalizer can still call the service it was using.

- A fiber that is still healthy keeps running while consumers drain.
- A fiber that fails during draining adds its `Cause` to the mount's failure.
- All fibers are interrupted before the mount's scope closes.

Use `Graft.fork` for work whose failure should fail the mount. Use
`Effect.forkScoped` for work that belongs to a smaller scope and reports its
failure elsewhere.
