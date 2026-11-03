# @nmnmcc/graft-hmr

Scoped hot reload for Graft plugins on Node.js. Module evaluation must be
side-effect free: acquire resources in `Plugin.apply`, inside its activation
scope.

```ts
import * as Hmr from "@nmnmcc/graft-hmr"
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
	const hmr = yield* Hmr.make({ base: import.meta.url })

	// Pass this callback to the loader:
	// ModuleResolver.layer({ base: projectDirectory, importer: hmr.importer })
	const module = yield* Effect.promise(() => hmr.importer("./plugin.mjs"))
	// The loader selects and installs the exported plugin as usual.

	yield* hmr.watch([projectDirectory], { recursive: true }).pipe(
		Stream.runForEach((result) => Effect.logInfo(result)),
		Effect.forkScoped,
	)
})
```

`make` requires `Graft.Graft` and `Scope`. `watch` additionally requires
Effect's `FileSystem`; the CLI supplies `NodeFileSystem.layer`. Consume the
watch stream within the HMR scope. No watchers or hooks start at package import
time. Closing the scope waits for active imports and removes the hooks.

## Interface

- `make({ base, include? })`: `base` is an application **module URL**, usually
  `import.meta.url`, used to resolve relative and bare specifiers. The loader's
  `base` remains a filesystem directory.
- `hmr.importer(specifier): Promise<unknown>`: returns a module namespace and
  records its resolved entry URL and exported Plugin. A default Plugin takes
  precedence over a named `plugin`. Other exports are rejected. Repeated imports
  in one committed generation reuse Node's module cache. Failed imports are not
  registered; after a successful reload, retry them through the importer.
- `hmr.reload`: an Effect returning `Reloaded { entries }` or
  `Skipped { modules, reason: "restart-required" }`. Import and export
  validation failures use `HmrError`; its `cause` retains the original import
  rejection.
- `hmr.watch(paths, { debounce?, recursive?, onReady? })`: a stream of reload
  results. The default debounce is 50 ms. Failed candidates emit
  `Failed { cause }` with the complete Effect Cause and watching continues.
  Filesystem failures fail the stream. `onReady` runs for each installed
  watcher.

Importer calls and reloads share one Semaphore. Reload prepares a fresh URL
generation, imports and validates every registered entry whose file still
exists, calls `Graft.replace` once, then commits the generation. Missing entry
files are removed from the registry; missing dependencies still fail the reload.
Removing an entry does not dispose its active forks: the caller owns plugin
unloading. Even with no registered entries, reload commits a fresh generation so
the next import can recover from an earlier failure. Failure discards the
candidate bookkeeping without replacing any plugin. Failed generations are never
reused. No plugin activation happens during preparation; failures in `apply`
after replacement are reported by Graft and are not rolled back.

## Invalidation and limits

Every managed file receives the same new generation, including dependencies. No
reverse dependency graph is needed. Watch paths are explicit; every event in
those paths triggers a reload after debouncing, including create/remove events.

By default, file URLs outside `node_modules` are managed. Explicit entry URLs
are always managed. Other dependencies keep their normal Node identity. Use
`include(url)` to change this boundary, for example to reload dependencies in an
installed plugin package. The predicate receives **resolved, realpath URLs**;
canonicalize directory prefixes before comparing them. Keep framework and
third-party runtime libraries shared unless re-evaluation is intentional.

Managed CommonJS modules and native addons cannot be reloaded. Existing ones
make reload return `Skipped`; newly introduced ones are rejected during
preparation before execution and also return `Skipped`. Restart the process.
Excluded dependencies are not watched or invalidated by the module hooks.

Node's synchronous
[`registerHooks` API](https://nodejs.org/api/module.html#moduleregisterhooksoptions)
is required (Node 22.15+; tested on Node 26). Hooks version Node-resolved ESM
files; this is not a TypeScript compiler or a bundler integration. Native
dynamic imports cannot be cancelled, so an import with an unresolved top-level
await can delay reload and shutdown.

Node retains versioned ESM cache entries, including failed candidates. This
package makes **no memory reclamation guarantee**; restart long-running dev
processes as needed.

The integration suite bundles a test runtime into `.cache/integration` and loads
it through native Node `require`, bypassing Vite's module runner. It uses
temporary modules and real `NodeFileSystem` watchers.
