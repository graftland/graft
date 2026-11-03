# @graftland/hmr

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/hmr/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/hmr/README.zh-TW.md)

Reloads plugin modules on Node.js without restarting the process.

```sh
npm install @graftland/hmr effect
```

`Hmr.make` gives you an importer for the loader. It also gives you `reload` and
`watch`, which replace plugins with new code. It needs Node.js 22.19 or later.

## Watching files

`watch` uses native filesystem events, so reloads happen quickly. It also checks
the contents of loaded, versioned modules inside the watched paths once per
second. This catches changes that the native backend missed. For example:

- the startup window of the macOS directory watcher
- a save between an import and the watcher installation

How the checks work:

- A newly loaded module is compared with the bytes that its module hook read. So
  adding a plugin through configuration does not count as a file change.
- Each disk observation is tied to an import attempt and to the bytes that the
  attempt actually read.
- A newer committed or failed attempt makes older observations invalid. So a
  save between a snapshot and an import cannot leave the running plugin on the
  wrong version.
- An unchanged failed attempt stays acknowledged until the next change. Polling
  does not retry it again and again.
- The check respects `recursive`. It stops when the consumer closes the stream.
- Its cost depends on the contents of those modules, not on the size of the
  directory tree.

`watch(paths, options)` accepts `filter(absolutePath)` in addition to
`recursive`, `onReady`, and `debounce`. The predicate filters both native events
and periodic content checks. By default, every path is accepted. For example:

```ts
hmr.watch([directory], {
	recursive: true,
	filter: (path) => path.endsWith(".mjs"),
})
```

The CLI uses this filter for JavaScript and TypeScript module files outside
`node_modules`. YAML configuration changes belong to the loader. They never
trigger an HMR reload of every entry.

## Failures

Debouncing does not make file writes atomic. If a reload meets incomplete code,
it emits `Failed` with the original `Cause`. A later content change can start
recovery, even without another native event.

Watcher I/O failures and reconciliation I/O failures both fail the stream. So
consumers should handle both failure channels.

`onReady` reports that the watcher is installed. It is not an operating-system
delivery barrier.

## When a restart is needed

CommonJS and native dependencies need a process restart. HMR tracks dependency
facts by generation for the session. This includes dynamic imports during plugin
activation, after the entry import completes. Once HMR records such a
dependency, later reloads of that generation return `Skipped` with
`restart-required`.

Loading through `require` is not isolated by ESM URL versions. This includes
`require(esm)`. HMR is careful here. It treats a versioned module's import of
`node:module` (or `module`) as getting a native loading capability that it
cannot track. That dependency graph returns `Skipped / restart-required`, even
if the module only uses another utility from `node:module`. HMR records the
capability before use. This covers CommonJS cache hits, and it stays valid when
another entry gets the same capability. Use static or dynamic ESM imports for
dependencies that need hot reload.

Watchers report known native-loading restart requirements even without a file
notification, including when a plugin acquires the capability after startup. The
periodic status check suppresses unchanged reports. This warning does not mean
that a reload occurred.

Local file entry leases and their reachable dependency edges keep the requested
path and its resolved target, together with the importing parent and generation.
Reload checks this relationship before it imports, and again before it publishes
any replacement. The same owned graph supplies polling, including dependencies
from failed attempts awaiting retry; releasing the last lease removes its graph
from these checks. If a symlink target changed, reload returns
`Skipped / restart-required` with the affected request URLs. Every running
plugin stays unchanged. Polling checks this relationship too. This includes
targets with identical content and missed native events. Restart the process
after you retarget an entry or helper. HMR does not invalidate Node's resolution
caches. These checks cover local file requests in the tracked dependency graph.
They do not cover changes to package export maps or bare-package resolution.

## Entry leases

`importerScoped(specifier)` is an Effect that needs `Scope`. Each call owns a
lease on the entry. The last release removes the entry from later reloads.

`importerScoped(specifier, { observationScope })` separates the observation
lease from temporary importer resources. `ModuleResolver` passes this scope as
the importer's second argument. Keep it alive while failed entries await retry,
and close it when replacing the observation attempt or removing the entry.
Candidate resources can close immediately on failure without deleting that
observation. Omitting the option uses the caller's scope.

The CLI passes this importer to `ModuleResolver`. Each configuration entry owns
its observation scope independently of activation resources. A failed first
import remains observable after candidate cleanup. Retrying replaces the old
observation generation; removing or disabling the entry closes it.

How polling and restarts work with leases:

- Polling finds its file set from each live lease. It uses the running
  generation and the latest uncommitted import attempt.
- It keeps failed imports and missing local dependencies, so it can retry them.
- It stops reading an entry, and the dependencies only that entry uses, when the
  last owner closes.
- A successful replacement retires the old dependency graph.
- Only dependencies that can be reached from leased entries can require a
  restart.
- The Promise-based `importer` keeps its registrations until the HMR session
  closes.

## Replacement conflicts

Sometimes entries shared one Plugin object, but now they export different
objects. Then reload returns `Skipped` with reason `ambiguous-exports` and the
affected module URLs.

Two other cases return `Skipped` with reason `identity-conflict` and the
conflicting module URLs:

- Replacement identities overlap, such as `P → Q, Q → R`.
- A mapping does not match the existing runtime aliases.

In all of these cases, nothing is replaced. Restart the application, or restore
a mapping that can be represented. Validation and alias publication share the
core replacement transaction.

Native watcher producers observe their complete Exit after source cleanup and
before entering background stream merging. Mixed interruption failures are
logged there with the full Cause; pure interruption is silent. Ordinary backend
failures still propagate to the consumer without duplicate logging.

## Cancellation

When a module fails during cancellation, HMR records the original failure with
its full Cause. It does this before pending interruption can hide the completed
Exit.

## Documentation

- [Hot reload](https://graftland.github.io/graft/hot-reload/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
