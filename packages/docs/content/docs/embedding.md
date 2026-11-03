---
title: Use Graft in your program
description: Run plugins from your own Effect program, without the CLI.
---

The CLI is a small program on top of the libraries. You can run Graft from your
own Effect program the same way.

## Run plugins directly

`Graft.layer` creates the runtime. Load plugins in a scope; closing the scope
unloads them:

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import { Effect, Layer } from "effect"

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	yield* Graft.plugin(hello)
	return yield* Effect.never
})

program.pipe(
	Effect.scoped,
	Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	NodeRuntime.runMain,
)
```

Services in the layer's environment, here the Node.js services, are available to
every plugin. See
[Services from the environment](../services/#services-from-the-environment).

## Load entries

`Loader.plugin` runs a list of [entries](../config-file/#entry-fields) kept in
memory. Edits through the `Loader` service change only that list. The entries
need a `ModuleResolver` to turn names into plugins:

```ts
import { Loader, ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Loader.plugin, [
		{ id: "greeter", name: "greeter", config: { greeting: "Hello" } },
		{ id: "hello", name: "hello" },
	])
	return yield* Effect.never
})

const resolver = ModuleResolver.fromRecord({ greeter, hello })
```

`ModuleResolver.fromRecord` resolves names from a fixed table, which suits
bundled applications and tests. `ModuleResolver.layer({ base, importer })`
imports modules instead: relative names from `base`, and package names through
`importer`, usually `(specifier) => import(specifier)` from your application, so
that its dependencies are found.

Provide the resolver in the environment, next to the Node.js services:

```ts
program.pipe(
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

## Load a config file

`Include.Include` is the plugin behind `graft start`. It reads a YAML file,
writes edits back to it, and with `watch: true` picks up changes made by hand:

```ts
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

It needs `FileSystem` and `Path`, such as from `NodeServices.layer`. With
`initial`, it creates the file with these entries if it does not exist yet.
