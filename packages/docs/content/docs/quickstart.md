---
title: Quickstart
description:
  Mount an Effect layer at run time and change it while the program runs.
---

Graft is an Effect library, not a tool. You add it to a program that already
builds a runtime, and mount layers there.

## Install

```sh
npm install effect @graftland/graft
```

`effect` is a peer dependency; Graft needs version `4.1.*`.

## Mount a layer

Provide `Graft.layer` to the program, which closes with the runtime and unmounts
everything. A mount belongs to the scope you create it in.

```ts title="app.ts"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

export class Greeting extends Context.Service<Greeting, string>()(
	"app/Greeting",
) {}

const greeting = Layer.effect(Greeting, Effect.succeed("Hello"))

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(greeting, { name: "greeting" })
	yield* mount.await
	yield* Effect.log("The greeting is available")
})

// @effect-diagnostics-next-line strictEffectProvide:off -- main provides the graph once, at the application entry point
const main = program.pipe(Effect.scoped, Effect.provide(Graft.layer))
```

Run it with `Effect.runPromise` or inside `ManagedRuntime`, like any other
Effect program. `mount.await` waits until the mount is stable; a `Failed` build
fails it with its cause. When the closing `scoped` ends, the layer is torn down.

## Publish a value and rebuild

Configuration is not a special concept. Publish it as a service with
`Graft.publish`, and everything that requires it is rebuilt when you change it.

```ts import.meta.vitest name="quickstart: rebuild on a new value"
import { Context, Effect, Layer, Option, Stream } from "effect"

import { Graft, Mount } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

class Banner extends Context.Service<Banner, string>()("app/Banner") {}

const banner = Layer.effect(
	Banner,
	Effect.map(Region, (region) => `Serving ${region}`),
)

const states = await Effect.runPromise(
	Effect.gen(function* () {
		yield* Graft.publish(Region, "eu").pipe(
			Effect.flatMap((publication) => publication.await),
		)
		const mount = yield* Graft.mount(banner, {
			name: "banner",
			requires: [Region],
		})
		yield* mount.await
		return yield* Stream.runHead(mount.state)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
states // => Option.some(Mount.MountState.Active())
```

| Step                    | What happens                                                 |
| ----------------------- | ------------------------------------------------------------ |
| `Graft.publish`         | The value becomes a service that other mounts can require.   |
| `Graft.mount` with it   | The layer is built once `Region` is available.               |
| `publication.set("us")` | The banner is torn down and built again with the new region. |
| Closing the scope       | Both the mount and the publication are removed.              |

The `requires` list must cover the layer's input type; the compiler rejects a
list that does not. See [Mounting](../mounting/) and
[Publications](../publications/).
