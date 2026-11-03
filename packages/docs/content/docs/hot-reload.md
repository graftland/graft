---
title: Hot reload
description:
  How Graft swaps plugin code in a running Node.js process, and its limits.
---

With `graft start --watch`, changing an observed plugin module or dependency
replaces the affected plugins with the new code. The process keeps running. So
does everything that was not loaded from a plugin module, such as the services
in its environment.

## What happens on a save

1. Graft checks observed files after merging native event paths. An event alone
   does not trigger a reload: file contents or a tracked local resolution must
   actually change. Saving identical bytes or changing an unrelated file does
   not reload plugins.
2. Automatic reload invalidates changed module instances and their transitive
   importers, including cycles. Only affected entries are reimported. Entries
   sharing the same old Plugin object are checked together; unchanged
   dependencies and independent entries keep their existing instances.
3. All candidates must pass import, export identity and resolution checks before
   one [`Graft.replace`](../lifecycle/#replace-plugins) transaction publishes
   the replacements. Affected forks restart in the usual
   [withdrawal order](../services/#how-withdrawal-works). Shared dependencies
   stay consistent across the batch.
4. If a candidate fails, the old plugins keep running and the full cause is
   logged. HMR retains the changed modules and failed observations for the next
   change. A deleted plugin entry is an exception: it is dropped from the
   reload, while its existing forks keep running until unloaded. Events arriving
   during a reload remain available for the next pass.

After a reload attempt returns `Reloaded` or `Skipped`, the CLI calls
`loader.retry`. This retries failed entries and refreshes `!env` values
throughout the tree. Fixing a broken plugin can therefore start it without a
process restart.

Public `hmr.reload` always forces a fresh import of every registered entry and
its tracked dependencies. It also advances the import view when there are no
entries, allowing a failed first import to be retried. This differs from the
incremental reloads performed by `watch`.

Each module instance keeps its own resolution view. Late dynamic imports from
old code, including activation cleanup, do not switch to a global latest
version. Reused modules keep their dependency edges. Dynamic imports that have
never run cannot be discovered in advance.

Nearby file events are debounced for 50 ms. The CLI filters for `.js`, `.mjs`,
`.cjs`, `.ts`, `.mts`, and `.cts` files under the config directory, including
subdirectories, outside `node_modules`. YAML edits belong to the loader.

HMR polls metadata and local resolutions once per second. A stat fast path
avoids reading files whose metadata has not changed; native events force a
content check even when stat is unchanged. While idle, HMR audits contents at
least every ten seconds, so missed notifications for saves with the same size
and timestamps are still detected. Import baselines are SHA-256 digests of the
bytes actually loaded, so a save between import and watcher installation can
also be detected. Adding a plugin through configuration does not itself trigger
a reload.

Even with `recursive: true`, HMR installs nonrecursive watches on directories
from the observed dependency graph. It does not walk unrelated directories or
`node_modules`. Loaded `dist` modules remain observable. Missing paths use the
nearest existing ancestor, and the directory set is reconciled once per second.
Checks respect the watched paths, `recursive` and `filter`, and stop when the
stream closes. Reads run outside the session lock with bounded concurrency;
results are accepted only if the observation version still matches.

Each observation belongs to one import attempt and its actual source bytes.
After a new attempt, polling uses those bytes as its baseline, including when a
file returns to the previous snapshot during reload. A failed attempt advances
the baseline if it read source bytes. An unchanged failure does not cause a
polling retry loop.

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
released, those paths leave polling. A successful replacement retires only
observations no longer reachable from active or pending entries; reused
dependency instances remain owned. Real I/O errors on paths that still have an
owner continue to fail the watch stream.

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

Local file entries and their reachable dependency edges retain the importing
module instance, requested path and physical target. If an entry or helper
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

- **Importing a module must have no side effects.** Graft reimports affected
  modules during reload, and only `apply` runs inside a scope that Graft can
  close. Open connections, start servers and set timers in `apply`.
- Only ECMAScript modules can be reloaded. CommonJS and native dependencies
  require a process restart. Graft tracks dependencies by module instance,
  including dynamic imports made during `apply`. While a leased entry can reach
  such a dependency, reload returns `Skipped / restart-required`.
- Packages in `node_modules` are shared and not reloaded. Effect and Graft
  themselves must stay one copy. There is one exception: the module that a
  plugin is loaded from. A plugin from a package is imported again, but the
  other files of that package are not.
- The lowest supported Node.js version is 22.19. This matches the requirement of
  the CLI's Effect Node adapter, and it provides `module.registerHooks`.

## Limits

Node's ESM cache does not evict versioned module instances. Incremental reload
creates fewer instances, but they still accumulate during long development
sessions. HMR reclaims source digests, dependency observations and reachability
caches according to active and pending leases and the current import view.
Compact routing views remain until the session closes so old code can still
import modules. This does not put a hard upper bound on process memory or
eliminate the accumulation in Node's cache. Restart the process when needed; HMR
does not supervise or restart a child process. Do not use `--watch` in
production.

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

| Member                    | What it does                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make({ base, include })` | `base` is the module URL that names are resolved from, usually `import.meta.url`. `include(url)` picks the files that get new versions. By default it picks every file outside `node_modules`.                                                                                  |
| `importer(specifier)`     | Imports a plugin module and keeps it registered until the HMR session closes.                                                                                                                                                                                                   |
| `reload`                  | Forces a full reload of all registered entries and tracked dependencies. Returns `Reloaded` with the reloaded modules, or `Skipped` when a restart is needed. Fails with `HmrError` if a module does not import or does not export a plugin. Its `cause` is the original error. |
| `watch(paths, options)`   | A stream that incrementally reloads affected entries when observed contents or local resolutions under `paths` change. It first waits `debounce` (50 ms by default) for more changes. A failed reload is emitted as `Failed` with its cause, and watching goes on.              |

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

Reacquiring an entry in the same import view preserves its cached identity. The
current view retains facts needed for cache hits without watching unleased
entries. A committed reload retires that cache; observations survive only where
active, pending or reused graphs still need them.

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
