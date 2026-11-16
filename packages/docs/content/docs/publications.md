---
title: Publications
description:
  Put a value in the graph from outside a layer, and replace it while the
  application runs.
---

`Graft.publish` places one value in the graph under a service key. Everything
that requires the key is built with it and rebuilt when it changes.

## Publish a value

```ts import.meta.vitest name="publications: a published value reaches a layer"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, { region: string }>()(
	"app/Report",
) {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => ({ region })),
)

const region = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		const mount = yield* Graft.mount(report, { requires: [Region] })
		yield* mount.await
		const value = yield* Graft.await(Report)
		yield* publication.set("us")
		return value.region
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
region // => "eu"
```

A publication belongs to the scope that created it. `Graft.publish` returns as
soon as the publication is registered; its supervisor publishes the value
asynchronously. Call `yield* publication.await` before relying on the value.

Closing the scope withdraws the value, and the mounts that require it become
`Pending` or rebuild without it if the dependency was optional.

## Publish inside a mount

Calling `Graft.publish` inside a mount, in the layer's build or in a
`Graft.fork` fiber, makes the publication belong to that mount too.

- The publication is withdrawn when the mount is torn down.
- Publishing after the mount has started tearing down fails with a defect.

The publication still belongs to the scope that created it, so it also ends with
that scope.

## Replace the value

`Publication` adds `set` to the [mount handle](../mounting/#hold-the-mount):

| Member    | Behavior                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `set`     | Replaces the value and rebuilds everything that requires it.                                          |
| `state`   | Goes back to `Loading` while the dependents rebuild, then `Active`.                                   |
| `await`   | Waits until the publication is stable; a `Failed` state fails it with its cause, even with a `retry`. |
| `unmount` | Withdraws the value and removes the publication from the mount tree.                                  |

`set` completes when the change is accepted, not when rebuilding ends. Calling
it several times in quick succession may skip intermediate values; the last
accepted value wins.

## Rules

| Rule            | Detail                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Identity**    | A publication owns its key in its realm until it is unmounted.                                    |
| **Uniqueness**  | Only one publication or mount can provide a key in the same realm.                                |
| **Conflict**    | A value rejected because the key is taken fails the publication's `await` with `ServiceConflict`. |
| **Environment** | A published value shadows the same key from the environment while it exists.                      |
| **Order**       | Publishing and withdrawal share a transaction with the dependency check.                          |

Publishing a value that would rebuild its own provider is rejected the same way;
see [publication cycles](../isolation/#publication-cycles).

## Files and configuration

A config file is a list of values, so read the file where you create the
publications and publish each value once:

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class AppConfig extends Context.Service<AppConfig, { region: string }>()(
	"app/Config",
) {}

declare const readConfig: Effect.Effect<{ region: string }>

export const program = Effect.gen(function* () {
	const config = yield* readConfig
	const publication = yield* Graft.publish(AppConfig, config)
	yield* publication.await
})
```

Change the value with `publication.set`. Every mount that requires `AppConfig`
is rebuilt with the new one, so configuration changes take effect without
restarting the program.
