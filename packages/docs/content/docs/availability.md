---
title: Availability
description:
  Read a service while it is published, and stop work when it is withdrawn.
---

A service can appear and disappear while the application runs. Four operations
read services from the graph and react to that, without mounting a layer.

| Operation                      | Result                                     | When the service is withdrawn                |
| ------------------------------ | ------------------------------------------ | -------------------------------------------- |
| `Graft.watch(key)`             | `Stream<Option<S>>`                        | Emits `Option.none()`                        |
| `Graft.await(key)`             | `Effect<S>` after the service is published | The next read may not find it                |
| `Graft.use(key, f)`            | Runs `f` once with the value               | Interrupts `f`, fails `ServiceWithdrawn`     |
| `Graft.whileAvailable(key, f)` | Runs `f` on every value                    | Interrupts `f`, runs again on the next value |

These operations read services published in the graph. They do not see services
that only exist in the environment where `Graft.layer` was built.

## Watch a service

```ts
import { Context, Effect, Stream } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const regions = Graft.watch(Region).pipe(
	Stream.map((region) => (region._tag === "Some" ? region.value : "none")),
)
```

`watch` immediately emits the current availability, which may be
`Option.none()`, then one frame each time the published value's identity
changes. It holds a slot so the identity survives while nothing is published.
Use it for status displays and for reacting to configuration changes.

## Use a service for one run

`Graft.use` waits for the service, leases it, and runs your effect. If the
service is withdrawn first, the effect is interrupted and `use` fails with
`Graft.ServiceWithdrawn`.

```ts import.meta.vitest name="availability: use a published service"
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		return yield* Graft.use(Region, (region) => Effect.succeed(`in ${region}`))
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "in eu"
```

The lease makes withdrawal wait: a provider is not torn down until every `use`
that holds one of its services has finished. This also applies to mounts that
require the service.

## Run while a service is available

`Graft.whileAvailable` starts `f` for each published value. Withdrawal
interrupts `f`; when the service is published again, `f` runs again with the new
value.

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

export const program = Graft.whileAvailable(Region, (region) =>
	Effect.log(`Serving ${region}`),
)
```

| If `f`…      | Then                                                         |
| ------------ | ------------------------------------------------------------ |
| completes    | It waits for the next value.                                 |
| fails        | `whileAvailable` fails with that error and stops.            |
| is withdrawn | It is interrupted, and a new run starts with the next value. |

## Wait for a service

`Graft.await` waits until the service is published and returns it. It does not
hold the service afterwards: it can be withdrawn immediately after the call
returns. Use `use` or `whileAvailable` when the work must keep the service
alive.

## Choose the operation

| You want to…                          | Use                           |
| ------------------------------------- | ----------------------------- |
| Show whether a service exists         | `watch`                       |
| Read a value and let it go            | `await`                       |
| Do one job that needs the service     | `use`                         |
| Keep working for as long as it exists | `whileAvailable`              |
| Build a layer that needs the service  | `Graft.mount` with `requires` |

Mounts get the same guarantees through `requires` and leases; see
[lifecycle](../lifecycle/).
