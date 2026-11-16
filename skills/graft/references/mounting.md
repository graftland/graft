# Mounting layers and publishing values

A mount is one `Layer` placed in the graph. Graft builds it while everything it
requires is available, publishes every service it provides, and tears it down —
dependents first — when a requirement changes. Mounts belong to the `Scope` they
are created in; closing that scope unmounts them.

## The graph

Provide `Graft.layer` once, like any Layer:

```ts
import { Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

const program = main.pipe(Effect.provide(Graft.layer))
```

Build it into a `ManagedRuntime` or `Effect.runMain`; the layer closes when the
runtime does.

## Mount a layer

```ts
const mounted = Effect.gen(function* () {
	const mount = yield* Graft.mount(pricingLayer, {
		name: "pricing",
		requires: [Database, Graft.optional(Cache)],
		retry: Schedule.exponential("1 second"),
	})
})
```

| Option      | Effect                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| `requires`  | The keys the layer needs from the graph. Must cover the layer's `RIn`.                  |
| `retry`     | Rebuilds a failed mount on this schedule; without it a failed mount waits for a change. |
| `name`      | Shown in the mount tree and log annotations.                                            |
| `isolate`   | Gives the services their own [realm](isolation.md).                                     |
| `intercept` | Adjusts a `Context.Reference` for this mount and everything below it.                   |

- **Outputs are published for you.** Everything in the built `Context` becomes
  available to the graph; there is no `provides` list.
- **Only what is published counts.** Services from the environment `Graft.layer`
  was built in satisfy `requires` too, but they do not appear in
  `Graft.watch`/`mounts`.
- The mount is built when every required key is available. A missing required
  key leaves it `Pending` with the missing names.
- Mounting the same layer twice yields two independent mounts.

## Optional requirements

`Graft.optional(Key)` does not block the build; it only makes the mount rebuild
when the key appears or disappears. Read it inside the layer with
`Effect.serviceOption`:

```ts
const pricingLayer = Layer.effect(
	Pricing,
	Effect.gen(function* () {
		const db = yield* Database
		const cache = yield* Effect.serviceOption(Cache)
		return Pricing.make({ db, cache })
	}),
)

const mounted = Effect.gen(function* () {
	yield* Graft.mount(pricingLayer, {
		requires: [Database, Graft.optional(Cache)],
	})
})
```

## Publish values

A value placed in the graph directly, such as config, is a publication. Its
`set` replaces the value, which tears down and rebuilds everything that requires
it:

```ts
const program = Effect.gen(function* () {
	const config = yield* Graft.publish(AppConfig, { region: "eu" })
	yield* config.await // now consumers can see it
	yield* config.set({ region: "us" })
})
```

- **`publish` returning does not mean the value is available.** It creates the
  publication mount; `yield* publication.await` (or `publication.stable`) waits
  until it is actually published before other code relies on it.
- A publication is a mount too: it has the same handle (below) plus `set`.
- `set` completes when the change is accepted, not when rebuilding ends.
  Concurrent calls may skip intermediate values.
- There is one provider per key per realm. A second one fails with
  `ServiceConflict`; isolate it or unmount the other.

## The mount handle

`Graft.mount` and `Graft.publish` return a handle:

| Member    | Use                                                                                          |
| --------- | -------------------------------------------------------------------------------------------- |
| `id`      | Stable identity in `Graft.mounts` and logs.                                                  |
| `state`   | `Stream<Mount.MountState>`: current state, every change, ending with `Unmounted`.            |
| `await`   | Waits until settled; fails with the build's cause if it ends `Failed`. `Pending` is settled. |
| `stable`  | Waits until this mount and its children have no `Loading` states.                            |
| `restart` | Tears down and rebuilds, even if nothing changed.                                            |
| `unmount` | Tears down and removes it, with its children; fails with `CleanupError`.                     |
| `set`     | Publication only: replace the value.                                                         |

`Mount.MountState` is `Loading`, `Pending { missing }`, `Active`,
`Failed { cause }` or `Unmounted`.

```ts
mount.state.pipe(Stream.filter(Mount.MountState.$is("Active")), Stream.runHead)
```

## Failures

A failed build or a failed background fiber (`Graft.fork`) puts the mount in
`Failed` with the full `Cause`; consumers waiting on its services wait in
`Pending`. It rebuilds when a requirement changes or when its `retry` schedule
fires. Read more in [troubleshooting](troubleshooting.md).
