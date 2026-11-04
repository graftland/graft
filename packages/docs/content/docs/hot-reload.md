---
title: Hot reload
description:
  How Graft swaps plugin code in a running Node.js process, and its limits.
---

With `graft start --watch`, saving a plugin module replaces the running plugin
with the new code. The process keeps running. So does everything that was not
loaded from a plugin module, such as the services in its environment.

For [remote plugins](../remote/host/#hot-reload), reloading the host entry
replaces the child execution; implementation modules installed on a runner are
outside the host HMR graph.

## What happens on a save

1. Graft imports every registered plugin module again, as a new **generation**.
   Each module URL gets a generation number. Node's module hooks also give every
   module that the plugin imports a new version in that generation. So a change
   to a helper file reaches the plugins that use it.
2. If every module imports and still exports a plugin, Graft calls
   [`Graft.replace`](../lifecycle/#replace-plugins) with all the new plugins in
   one transaction. Every module made a new plugin. So every fork that was
   loaded from a module restarts with the new code, in the usual
   [withdrawal order](../services/#how-withdrawal-works).
3. If any module fails to import, Graft replaces nothing. The old code keeps
   running, and the error is logged with its cause. There is one exception: a
   plugin module whose file was deleted. Graft drops it from the reload and
   replaces the other plugins as usual. Its forks keep running the old code
   until they are unloaded.

After a reload, Graft tries again the entries whose plugin could not be loaded
before. So if you fix a broken plugin, it starts without a restart.

Nearby file events are debounced for 50 ms. The CLI watches `.js`, `.mjs`,
`.cjs`, `.ts`, `.mts`, and `.cts` files in all folders under the config
directory, except `node_modules`. The loader handles YAML edits. They do not
reload every plugin module.

Native watchers can miss notifications, for example during startup on macOS. So
HMR also checks the contents of loaded modules once per second, within the
watched paths. The baseline comes from the bytes that were actually imported. So
a save made before the watcher was installed is detected. Adding a plugin
through configuration does not trigger a reload by itself. The checks compare
content, so they also catch changes of the same size. They stop when the watcher
stops. Each observation belongs to one import attempt and its actual source
bytes. After a new attempt, polling checks against those bytes again. This
includes the case where a file goes back to the previous snapshot during a
reload. A failed attempt also moves this baseline forward, if its source bytes
were read. An unchanged failure does not cause a polling retry loop. The cost of
the checks grows with the contents of the loaded modules.

An incomplete write can make a reload fail. Graft logs the full cause and keeps
watching. A later content change can recover, even without a native event. The
CLI also logs watcher I/O failures and installs the watcher again after one
second.

The CLI registers each module for as long as its configuration entry lives. If
you remove or disable the entry, it releases its lease. After the last lease
closes, reload no longer imports that entry. Pending and failed activations keep
their leases, so that changes can still recover them. Unloaded entries, and
their exclusive CommonJS dependencies, cannot block the remaining entries.
Polling also follows the leases. It covers the running dependency graph of each
live entry and its latest uncommitted import attempt. This includes failed
imports and missing local files that retries need. When the last owner is
released, those paths leave polling. A successful replacement retires the old
graph. Real I/O errors on paths that still have an owner continue to fail the
watch stream.

Failed first imports keep an observation lease owned by the configuration entry,
separate from the candidate resource scope that closes immediately on failure.
Fixing the module can therefore recover through polling even when the native
notification is lost. Retry replaces the observation generation; removal or
disabling closes it.

Suppose two entries exported the same Plugin object before, but now export
different ones. Then reload returns `Skipped` with reason `ambiguous-exports`
and the conflicting module URLs. The CLI reports that a restart is needed. All
old plugins stay in place. If the shared export comes back, reload can recover
too. The new and old replacement identities must also fit the runtime's aliases.
For example, `P → Q, Q → R` cannot describe two independent replacements. Reload
then returns `Skipped` with reason `identity-conflict` and the conflicting
module URLs. Validation rejects the whole batch before it publishes aliases or
changes any fork.

Failures that finish during cancellation are handed over as complete Exits
before interruption is restored. HMR records an original failure that the
cancellation would otherwise hide, including its full Cause.

If a versioned module imports `node:module` or `module`, HMR plays safe and
requires a restart. This records the native loading ability before a
`createRequire` call can hit a cache. It covers `require(esm)` as well as
CommonJS. Even if you use an unrelated utility from that module, this graph is
out of hot reload. Use ESM imports for dependencies that must reload.

Watchers report known native-loading restart requirements even without a file
notification, including when a plugin acquires the capability after startup. The
periodic status check suppresses unchanged reports. This warning does not mean
that a reload occurred.

Local file entries and their reachable dependency edges retain the generation,
importing parent, requested path and physical target. If an entry or helper
symlink changes targets, reload returns `Skipped / restart-required` with the
affected request URLs before replacing any plugin. The same owned graph is
checked before imports, before replacement and during polling. Failed attempts
remain tracked until their lease is released. Polling detects target changes
even with identical bytes and lost native events. Restart to use the new target;
HMR does not clear Node's resolution caches. This check does not re-resolve bare
packages or package export maps.

Native watcher producers observe their complete Exit after source cleanup and
before entering background stream merging. Mixed interruption failures are
logged there with the full Cause; pure interruption is silent. Ordinary backend
failures still propagate to the consumer without duplicate logging.

## Rules for plugin modules

- **Importing a module must have no side effects.** Graft imports modules again
  for every reload, and only `apply` runs inside a scope that Graft can close.
  Open connections, start servers and set timers in `apply`.
- Only ECMAScript modules can be reloaded. If a CommonJS module or a native
  addon changes, Graft logs that a restart is needed. Graft tracks dependencies
  by generation for the whole session. This includes dynamic imports that
  `apply` makes later. These dependencies also make later reloads return
  `Skipped`.
- Packages in `node_modules` are shared and not reloaded. Effect and Graft
  themselves must stay one copy. There is one exception: the module that a
  plugin is loaded from. A plugin from a package is imported again, but the
  other files of that package are not.
- The lowest supported Node.js version is 22.19. This matches the requirement of
  the CLI's Effect Node adapter, and it provides `module.registerHooks`.

## Limits

Node keeps every module version that it imported in memory, and you cannot
remove one. So each reload uses some memory that is never freed. This is fine
while you develop. Restart long-running development processes now and then, and
do not use `--watch` in production.

An import that never finishes holds up later reloads and shutdown. An example is
a module with a top-level `await` that never resolves. This is because a dynamic
import cannot be cancelled.

## Use it in your own program

The `@graftland/hmr` package works without the CLI:

```ts
import * as Hmr from "@graftland/hmr"
import { ModuleResolver } from "@graftland/loader"

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

| Member                    | What it does                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make({ base, include })` | `base` is the module URL that names are resolved from, usually `import.meta.url`. `include(url)` picks the files that get new versions. By default it picks every file outside `node_modules`.         |
| `importer(specifier)`     | Imports a plugin module and keeps it registered until the HMR session closes.                                                                                                                          |
| `reload`                  | Returns `Reloaded` with the reloaded modules, or `Skipped` when a restart is needed. Fails with `HmrError` if a module does not import or does not export a plugin. Its `cause` is the original error. |
| `watch(paths, options)`   | A stream that reloads after files under `paths` change. It first waits `debounce` (50 ms by default) for more changes. A failed reload is emitted as `Failed` with its cause, and watching goes on.    |

`importerScoped(specifier)` returns an Effect that needs a `Scope`. Each call
holds an entry lease until that scope closes. Pass it to `ModuleResolver.make`.
It accepts Effect importers as well as Promise importers. The Promise-based
`importer(specifier)` keeps its registrations for the whole HMR session instead.

`importerScoped(specifier, { observationScope })` separates the observation
lease from temporary importer resources. `ModuleResolver` passes this scope as
the importer's second argument. Keep it alive while failed entries await retry,
and close it when replacing the observation attempt or removing the entry.
Candidate resources can close immediately on failure without deleting that
observation. Omitting the option uses the caller's scope.

`WatchOptions.filter(absolutePath)` selects which files can trigger reloads. The
same predicate applies to native events and to the periodic content checks. If
you leave it out, every path is accepted. `recursive` controls subdirectories.
For example:

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

A reload failure is a `Failed` value that holds the full `Cause`. Watcher and
content-check I/O failures fail the stream itself, so callers must handle that
channel too. `onReady` reports that the watcher is installed. It does not
promise that the operating system will deliver every event.
