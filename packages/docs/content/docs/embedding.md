---
title: Use Graft in your program
description: Run plugins from your own Effect program, without the CLI.
---

The CLI is a small program built on top of the libraries. You can run Graft from
your own Effect program in the same way.

## Run plugins directly

`Graft.layer` creates the runtime. Load plugins in a scope. Closing the scope
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

Services in the layer's environment are available to every plugin. Here these
are the Node.js services. See
[Services from the environment](../services/#services-from-the-environment).

## Load entries

`Loader.plugin` runs a list of [entries](../config-file/#entry-fields) kept in
memory. Edits made through the `Loader` service change only that list. The
entries need a `ModuleResolver` to turn names into plugins:

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

`ModuleResolver.fromRecord` resolves names from a fixed table. This suits
bundled applications and tests. `ModuleResolver.layer({ base, importer })`
imports modules instead. It resolves relative names from `base`, and package
names through `importer`. Usually `importer` is
`(specifier) => import(specifier)` written in your application, so that it finds
your application's dependencies.

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

### Resolution plans

`ModuleResolver.make` caches normalized candidate plans, never importer results.
Without the optional `resolution` environment, each call still tries the
original name before the naming conventions. The successful importer runs on
every call, so custom importers keep their per-call behavior and resource
scopes.

A `resolution` environment can skip candidates known to be absent:

- `revision` is an Effect returning the resolution-environment version. Advance
  it after installation, removal or another resolution change to discard cached
  plans, including negative decisions.
- `exists(specifier)` checks a normalized candidate without importing it or
  acquiring resources. Candidate priority stays unchanged.
- `observe(specifiers, { observationScope })` runs on every resolve, including
  cache hits and failed plans, to retain observations of missing names or paths.
  Its resources follow the candidate and observation scopes.

Supply both invalidation and observation when opting in. Without a reliable
revision, leave `resolution` unset. An older in-flight plan cannot overwrite a
newer cached revision.

## Load a config file

`Include.Include` is the plugin behind `graft start`. It reads a YAML file and
writes edits back to it. With `watch: true`, it also picks up changes that you
make by hand:

```ts
import { Include } from "@graftland/loader"

const program = Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
})
```

It needs `FileSystem` and `Path`, for example from `NodeServices.layer`. With
`initial`, it creates the file with these entries if the file does not exist
yet.
