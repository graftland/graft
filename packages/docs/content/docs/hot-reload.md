---
title: Hot reload
description:
  How Graft swaps plugin code in a running Node.js process, and its limits.
---

With `graft start --watch`, saving a plugin module replaces the running plugin
with the new code. The process keeps running, and so does everything that was
not loaded from a plugin module, such as the services in its environment.

## What happens on a save

1. Graft imports every plugin module again, as a new **generation**. Each module
   URL gets a generation number, and Node's module hooks give every module the
   plugin imports a new version in that generation too. So a change to a helper
   file reaches the plugins that use it.
2. If every module imports and still exports a plugin, Graft calls
   [`Graft.replace`](../lifecycle/#replace-plugins) with all the new plugins in
   one transaction. Every module produced a new plugin, so every fork loaded
   from a module restarts with the new code, in the usual
   [withdrawal order](../services/#how-withdrawal-works).
3. If any module fails to import, nothing is replaced. The old code keeps
   running, and the error is logged with its cause. A plugin module whose file
   was deleted is the exception: it is dropped from the reload, and the other
   plugins are replaced as usual. Its forks keep running the old code until they
   are unloaded.

After a reload, entries whose plugin could not be loaded before are tried again,
so fixing a broken plugin brings it up without a restart.

Several file events from one save cause one reload.

## Rules for plugin modules

- **Importing a module must have no side effects.** Graft imports modules again
  for every reload, and only `apply` runs inside a scope that Graft can close.
  Open connections, start servers and set timers in `apply`.
- Only ECMAScript modules can be reloaded. A change to a CommonJS module or a
  native addon logs that a restart is needed.
- Packages in `node_modules` are shared, not reloaded. Effect and Graft
  themselves must stay one copy. The one exception is the module a plugin is
  loaded from: a plugin from a package is imported again, but the other files of
  that package are not.
- Node.js 22.15 or later is needed, for `module.registerHooks`.

## Limits

Node keeps every module version it imported in memory, and there is no way to
remove one. Each reload therefore uses some memory that is never freed. This is
fine while developing; restart long-running development processes now and then,
and do not use `--watch` in production.

An import that never finishes, such as a module with a top-level `await` that
never resolves, holds up later reloads and shutdown, because a dynamic import
cannot be cancelled.

## Use it in your own program

The `@graftland/hmr` package works without the CLI:

```ts
import * as Hmr from "@graftland/hmr"
import { ModuleResolver } from "@graftland/loader"

const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: hmr.importer,
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	// ...load plugins through the resolver, then, after files changed:
	const result = yield* hmr.reload
	yield* Effect.log(result)
})
```

`make` needs `Graft.Graft` and a `Scope`. Closing the scope waits for running
imports and removes the module hooks. Importing the package starts nothing.

| Member                    | What it does                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include })` | `base` is the module URL that names are resolved from, usually `import.meta.url`. `include(url)` picks the files that get new versions: by default, every file outside `node_modules`.        |
| `importer(specifier)`     | Imports a plugin module and remembers it, so the next reload includes it. Pass it to `ModuleResolver`.                                                                                        |
| `reload`                  | Returns `Reloaded` with the reloaded modules, or `Skipped` when a restart is needed. Fails with `HmrError` if a module does not import or export a plugin; its `cause` is the original error. |
| `watch(paths, options)`   | A stream that reloads after files under `paths` change, waiting `debounce` (50 ms by default) for more changes. A failed reload is emitted as `Failed` with its cause, and watching goes on.  |
