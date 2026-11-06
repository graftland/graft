---
title: HMR API
description: Use @graftland/hmr from your own program, without the CLI.
---

The `@graftland/hmr` package works without the CLI. For what hot reload does,
see [Hot reload](../hot-reload/).

```ts
import { Effect } from "effect"

import { Graft } from "@graftland/graft"
import * as Hmr from "@graftland/hmr"
import { ModuleResolver } from "@graftland/loader"

declare const directory: string

const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: hmr.importerScoped,
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	// ...load plugins through the resolver, then, after files changed:
	const result = yield* hmr.reload
	yield* Effect.log(result)
})
```

`make` needs `Graft.Graft` and a `Scope`. When you close the scope, it waits for
running imports and removes the module hooks. Importing the package starts
nothing.

## Members

| Member                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include, activationTimeout })` | `base` is the module URL that names are resolved from, usually `import.meta.url`. `include(url)` picks the files that get new versions. By default it picks every file outside `node_modules`. `activationTimeout` is how long reloaded plugins may take to start before the reload is rolled back; 30 seconds by default.                                                                                                                         |
| `importer(specifier)`                        | Imports a plugin module and keeps it registered until the HMR session closes.                                                                                                                                                                                                                                                                                                                                                                      |
| `importerScoped(specifier, options?)`        | Returns an Effect that needs a `Scope`. Each call holds an entry lease until that scope closes. See [Scoped importers](#scoped-importers).                                                                                                                                                                                                                                                                                                         |
| `reload`                                     | Forces a full reload of all registered entries and tracked dependencies. Returns `Reloaded` with the reloaded entries, `RolledBack` with the entries and their [failures](../replace/#rollback) when a reloaded plugin fails to start, or `Skipped` when the change [cannot apply](../hot-reload/#when-a-reload-does-not-apply). Fails with `HmrError` if a module does not import or does not export a plugin. Its `cause` is the original error. |
| `watch(paths, options)`                      | A stream that incrementally reloads affected entries when observed contents or local resolutions under `paths` change. It first waits `debounce` (50 ms by default) for more changes. A failed reload is emitted as `Failed` with its cause, and watching goes on.                                                                                                                                                                                 |

## Scoped importers

| Importer                    | Lease lasts until…            | Accepts                                 |
| --------------------------- | ----------------------------- | --------------------------------------- |
| `importer(specifier)`       | The whole HMR session closes. | Promise importers.                      |
| `importerScoped(specifier)` | The caller's scope closes.    | Effect importers and Promise importers. |

Pass `importerScoped` to `ModuleResolver.make`.

`importerScoped(specifier, { observationScope })` separates the observation
lease from temporary importer resources.

- `ModuleResolver` passes this scope as the importer's second argument.
- Keep it alive while failed entries await retry, and close it when replacing
  the observation attempt or removing the entry.
- Candidate resources can close immediately on failure without deleting that
  observation.
- Omitting the option uses the caller's scope.

Reacquiring an entry in the same import view preserves its cached identity. The
current view retains facts needed for cache hits without watching unleased
entries. A committed reload retires that cache; observations survive only where
active, pending or reused graphs still need them.

## Watching

`WatchOptions` controls what the stream sees:

| Option                 | Meaning                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `filter(absolutePath)` | Selects which files can trigger reloads. It applies to native events and to periodic content checks. If omitted, every path is accepted. |
| `recursive`            | Controls subdirectories.                                                                                                                 |
| `debounce`             | How long to wait for more changes. 50 ms by default.                                                                                     |
| `onReady`              | Reports that the watcher is installed. It does not promise that the operating system delivers every event.                               |

```ts
import { String } from "effect"

import type * as Hmr from "@graftland/hmr"

declare const hmr: Hmr.Hmr
declare const directory: string

const results = hmr.watch([directory], {
	recursive: true,
	filter: String.endsWith(".mjs"),
})
```

### Handling failures

| Failure                              | Where it appears                                                  |
| ------------------------------------ | ----------------------------------------------------------------- |
| A reload failure                     | A `Failed` value holding the full `Cause`.                        |
| Watcher or content-check I/O failure | The stream itself fails, so callers must handle that channel too. |
