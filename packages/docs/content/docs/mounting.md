---
title: Mounting
description:
  Place a layer in the graph and keep it alive while its requirements are
  available.
---

`Graft.mount` places a `Layer` in the graph. The layer is built while every
entry in its `requires` list is available, and its services are published.

## Mount a layer

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Pricing extends Context.Service<Pricing, string>()("app/Pricing") {}

const pricing = Layer.effect(
	Pricing,
	Effect.map(Database, (database) => `prices from ${database}`),
)

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(pricing, {
		name: "pricing",
		requires: [Database],
	})
	yield* mount.await
})
```

| Argument | What it is                                                        |
| -------- | ----------------------------------------------------------------- |
| 1st      | The layer. Any layer whose input type the `requires` list covers. |
| 2nd      | Options: `name`, `requires`, `retry`, `isolate` and `intercept`.  |

A mount belongs to the current scope. Closing that scope unmounts it, and a
mount created inside a layer is a child of that mount. See
[lifecycle](../lifecycle/).

## Declare what the layer needs

`requires` names the services the layer reads from the graph. The compiler
compares it with the layer's input type, so a layer that needs a service cannot
be mounted without listing it.

```ts title="pricing.ts"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Cache extends Context.Service<Cache, string>()("app/Cache") {}
class Pricing extends Context.Service<Pricing, string>()("app/Pricing") {}

export const pricing = Layer.effect(
	Pricing,
	Effect.gen(function* () {
		const database = yield* Database
		const cache = yield* Effect.serviceOption(Cache)
		return cache._tag === "Some" ? `${database} with ${cache.value}` : database
	}),
)

export const mount = Graft.mount(pricing, {
	name: "pricing",
	requires: [Database, Graft.optional(Cache)],
})
```

- A required entry keeps the mount `Pending` until it is available.
- `Graft.optional(key)` does not block the build. The mount is rebuilt whenever
  that entry appears or disappears.
- Read an optional entry with `Effect.serviceOption`, never with `yield* key`.

## Publish what the layer provides

Graft publishes every service in the layer's output context. You do not list
provided keys; the layer's type is the list.

Compose internal dependencies with `Layer.provide`, not `Layer.provideMerge`.
`provideMerge` leaves them in the output, so Graft publishes them too, and
another mount in the same realm then fails with `ServiceConflict`.

Effect's internal `Layer.CurrentMemoMap` is never published, even if the layer
outputs it.

- Two mounts cannot publish the same key in one realm. The second build fails
  with `Graft.ServiceConflict`; see [isolation](../isolation/).
- A published service lasts until the mount is torn down or rebuilt.
- A rebuild withdraws the old services, waits for their consumers, and then
  publishes the new ones.

## Choose the options

| Option      | Type                                                | Effect                                                                                |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `name`      | `string`                                            | Label in the mount tree and log annotations. Defaults to `"layer"`.                   |
| `requires`  | `ReadonlyArray<Dependency>`                         | Entries that gate the build. See above.                                               |
| `retry`     | `Schedule`                                          | Rebuilds a failed mount on this schedule. See [failures](../failures-retry/).         |
| `isolate`   | `ReadonlyArray<Isolatable \| [Isolatable, string]>` | Gives these services their own realm. See [isolation](../isolation/).                 |
| `intercept` | `ReadonlyArray<Intercept>`                          | Adjusts references for this mount and its children. See [intercepts](../intercepts/). |

## Hold the mount

`Graft.mount` returns a `Mount`:

| Member    | Type                         | Use                                                                           |
| --------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `state`   | `Stream<MountState>`         | The current state and every change, ending with `Unmounted`.                  |
| `await`   | `Effect<void, E>`            | Waits until stable (not `Loading`); a `Failed` state fails it with its cause. |
| `stable`  | `Effect<void>`               | Waits until the mount and its children have no `Loading` state.               |
| `restart` | `Effect<void>`               | Tears down and builds again, even if nothing changed.                         |
| `unmount` | `Effect<void, CleanupError>` | Tears down the mount and everything below it.                                 |

`await` waits until the mount is stable: the first state that is not `Loading`.
`Pending` counts as stable. A `Failed` state fails `await` with its cause, even
when a `retry` schedule is set: the first `Failed` ends `await`, and later
attempts continue in the background. Observe them through `state`, or call
`await` again.

Read one state with `Stream.runHead`, or follow the whole stream. See
[lifecycle](../lifecycle/#mount-states).

## Services from the environment

Services in the environment where `Graft.layer` is built are visible to every
mount, and can satisfy `requires` without a publication:

```ts
import { FileSystem, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

export const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

A mount still watches its realm: when a publication of the same key appears, the
mount rebuilds with the published value, and rebuilds again when it is
withdrawn. Services in the graph win over the environment.
