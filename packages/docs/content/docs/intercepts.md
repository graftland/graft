---
title: Intercepts
description: Adjust a Context.Reference for one mount and everything below it.
---

An **intercept** changes a `Context.Reference` value for one mount. Layers and
children below that mount read the adjusted value, while the rest of the
application keeps the original.

## Intercept a reference

```ts import.meta.vitest name="intercepts: adjust a reference"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const Prefix = Context.Reference<string>("app/Prefix", {
	defaultValue: () => "Hello",
})

const greeting = Layer.effect(
	Greeting,
	Effect.map(Prefix, (prefix) => `${prefix}, world`),
)

const text = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(greeting, {
			name: "greeting",
			requires: [Prefix],
			intercept: [Graft.intercept(Prefix, (prefix) => `${prefix}!`)],
		})
		yield* mount.await
		return yield* Graft.await(Greeting)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
text // => "Hello!, world"
```

`Graft.intercept` takes the reference and a function from the outer value to the
new one. Several intercepts for the same reference apply from the inside out:
the last one in the list sees the result of the earlier ones.

## What an intercept reaches

| Reaches                              | Does not reach                      |
| ------------------------------------ | ----------------------------------- |
| The mount's own build                | Sibling mounts                      |
| Its background fibers                | Its parent                          |
| Every child mount and their children | Services published in another realm |
| References read through `requires`   | Non-reference services              |

Intercepts travel with the context the mount was created in, so a child adds its
own intercepts on top of what it inherited.

## Order of resolution

For a reference in `requires`, the value resolves in this order:

1. A published value in the mount's realm.
2. The inherited reference value, including intercepts.
3. The reference's default.

A reference always has a fallback, so it never leaves a mount `Pending`. A
publication still wins, and the mount rebuilds when that value appears or goes
away. See [availability](../availability/) for reading the value directly.

## When to intercept

| Use an intercept to…                       | Use a publication to…                    |
| ------------------------------------------ | ---------------------------------------- |
| Give one subtree a different setting       | Change a value for the whole application |
| Narrow a timeout or flag for a tenant      | Read configuration from a file           |
| Adjust a reference a library already reads | Provide a service that did not exist     |

Use [isolation](../isolation/) when the goal is a separate provider rather than
a different reference value.
