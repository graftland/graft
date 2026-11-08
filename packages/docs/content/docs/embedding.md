---
title: Use Graft in your program
description: Run plugins from your own Effect program, without the CLI.
---

**Embedded Graft** composes plugins inside your Effect program. Its lifecycle is
cooperative; it provides no kernel Change outcomes, isolation or
termination-based reclamation.

| You want to…                        | Use                                    | Section                                       |
| ----------------------------------- | -------------------------------------- | --------------------------------------------- |
| Load a few plugins from code        | `Graft.layer` and `Graft.plugin`       | [Run plugins directly](#run-plugins-directly) |
| Load plugins from a list of entries | `Loader.plugin` and a `ModuleResolver` | [Load entries](#load-entries)                 |
| Load plugins from a YAML file       | `Include.Include`                      | [Load a config file](#load-a-config-file)     |
| Reload code without the CLI         | `@graftland/hmr`                       | [HMR API](../hmr-api/)                        |
| Test plugins                        | `@effect/vitest` and `Graft.layer`     | [Testing](../best-practices/testing/)         |

## Run plugins directly

`Graft.layer` creates the runtime. Load plugins in a scope. Closing the scope
unloads them:

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { greeter, hello } from "./plugins.ts"

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

export const run = () =>
	program.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
		NodeRuntime.runMain,
	)
```

Services in the layer's environment are available to every plugin. Here these
are the Node.js services. See
[Services from the environment](../services/#services-from-the-environment).

`greeter` and `hello` are ordinary plugins, and the other examples on this page
load them too. `greeter` publishes a `Greeter` service and `hello` injects it:

```ts title="plugins.ts"
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

export class Greeter extends Context.Service<
	Greeter,
	{ readonly greeting: string }
>()("app/Greeter") {}

export const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: (config) => Graft.provide(Greeter, config),
})

export const hello = Plugin.make({
	name: "app/hello",
	inject: [Greeter],
	apply: () =>
		Effect.flatMap(Greeter, ({ greeting }) =>
			Effect.log(`${greeting}, world!`),
		),
})
```

## Load entries

Embedded `Loader.plugin` loads built modules named by a list of entries.
Resolution uses a live public control endpoint for disposable inspection.
Relative includes keep their declaring directory.

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"
import type * as Control from "@graftland/plugin-remote/Control"

declare const control: Control.Address
const resolver = ModuleResolver.layer({ base: "/app", control }).pipe(
	Layer.provide(NodeServices.layer),
)
export const run = () =>
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(Loader.plugin, [
			{ id: "hello", name: "./dist/hello.js" },
		])
		yield* fork.stable
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(NodeServices.layer, resolver),
			),
		),
		NodeRuntime.runMain,
	)
```

| Boundary            | Rule                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| Resolution          | Returns a serializable descriptor; checks executable code in a disposable unit.        |
| Embedded activation | Runs in the embedding process and cooperatively owns its scopes.                       |
| Configuration       | Native preparation transfers JSON and immutable module identities.                     |
| Guarantees          | Embedded forks have no Change outcome, forced reclamation or code-unloading guarantee. |

Use real module files in tests. Build source changes and restart the embedded
process. [Loader API](../loader-api/) describes native preparation and the
embedded editing service.

## Load a config file

An embedded program can use `Include.Include` to read and edit YAML. Its
`watch: true` option observes file edits cooperatively. `graft start` reads one
revision and rejects `--watch`:

```ts
import { Effect } from "effect"

import { Graft } from "@graftland/graft"
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

| Requirement / option | Detail                                                                |
| -------------------- | --------------------------------------------------------------------- |
| Services             | Needs `FileSystem` and `Path`, for example from `NodeServices.layer`. |
| `initial`            | Creates the file with these entries if the file does not exist yet.   |
| `watch`              | Picks up changes made by hand.                                        |

For editing entries from code, see the [Loader API](../loader-api/).
