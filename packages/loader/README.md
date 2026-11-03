# @graftland/loader

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/loader/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/loader/README.zh-TW.md)

Loads plugins from a list of entries or a YAML config file.

The minimum supported Node.js version is 22.19.

```sh
npm install @graftland/loader effect
```

- `Include` keeps entries in a YAML file and writes edits back to it.
- `Loader` edits entries at run time.
- `ModuleResolver` turns entry names into plugins.

## Custom stores

A custom store implements `Loader.Store`:

- `initial` supplies the starting entries.
- `apply(op)` saves an API edit.
- `external: Stream<void>` signals that something may have changed.
- `refresh` reads the latest state.

`refresh` returns `Option.some(entries)` for a changed snapshot. It returns
`Option.none()` when nothing changed. The notification stream must not read or
change the store's snapshot.

Loader runs `apply` and `refresh` under the same lock. It publishes their saved
target before it releases the lock. So a store needs no extra lock.

Rules for store implementations:

- Commit a new snapshot only after the operation succeeds.
- Keep mutable parser objects local to that operation.

How Loader handles failures:

- A failed refresh is logged with its full cause. Loader keeps the last
  successful target and processes later notifications.
- Calling `apply` and accessing `refresh` are deferred inside that protected
  operation. A synchronous throw is reported as a defect. It does not strand
  replies or stop later edits.
- Accessing `external` is deferred inside its stream failure boundary. A defect
  stops notifications and is logged. API editing stays available.
- Module candidate fallback needs exactly one failure that says the candidate is
  missing. If cleanup failures, defects, or interruption come with it, there is
  no fallback, and the full Cause is kept.
- Resolver and intercept callbacks run inside the entry activation. An
  unexpected synchronous throw fails that entry with its original cause.

## API edits

API edits use a bounded queue. The loader's scope owns the queue.

- Entering the queue successfully is admission.
- Cancelling before admission has no effect.
- Cancelling after admission only stops waiting for the result.

The worker finishes saving and target publication under the same lock. It
delivers its `Exit` through a `Deferred`. Failures are also logged with their
full cause, even when the caller has stopped waiting.

Closing the loader does three things:

- It stops the worker.
- It settles pending callers.
- It rejects new edits with `LoaderClosed`.

## Reconciliation

A separate scoped fiber reconciles the latest target with the running tree. It
may skip intermediate targets. It never interrupts an update callback just to
apply a newer target.

Each group has one scoped reconciliation executor. Delayed environment refresh
waiters submit requests to it; they never call `Fork.update` themselves.
Requests identify the entry instance and reconciliation generation, so requests
from removed, replaced, or superseded entries are discarded. `ready` also waits
for queued and executing environment refreshes.

`entries` and `changes` describe saved targets, not finished runtime updates.
Edits return after saving and publication.

`retry` publishes the current target again, to retry every failed entry. This
includes module resolution, configuration preparation, and actual plugin
activation. It also does these things:

- It reads `!env` values again.
- Active entries get changed config through `update`.
- A changed intercept loads the entry again.
- An entry still loading reads them again once it is active, and `ready` waits
  for that read.
- Failed plugin forks restart, even under injection or group wrappers.
- Healthy instances and unfinished resolutions stay as they are.

Reconciliation of ordinary edits also retries failed entries.

`ready` waits until the current target version has been reconciled and no fork
is `Loading`. `Pending` and `Failed` count as settled. Lifecycle callbacks may
submit edits. They must not wait for `ready`, because that would wait for
themselves.

## Entry lifecycles

Each enabled entry gets a lifecycle fork at once. Module resolution and
configuration preparation run in that fork's activation. So a slow import stays
`Loading`. It does not block its siblings or later target reconciliation.

Removing, disabling, or replacing the entry closes that lifecycle and its
resolver resources. Its loading state then stops counting toward `ready`.

- A config change during resolution cancels that attempt and starts a new one
  with the latest input.
- Unrelated edits leave an unchanged resolution running.

Cleanup failure during removal, disabling, or replacement is logged with the
complete cause and the entry and fork identifiers. Reconciliation continues with
the rest of the target.

Entry disposal collects both lifecycle cleanup and resolver observation-scope
cleanup before reporting a `CleanupError`. Both causes are preserved when both
phases fail; a failure does not restart healthy siblings. Caller interruption
remains interruption, rather than becoming an entry cleanup error.

- The removed fork is disposed. It does not stay in the tree as a failed entry.
- A replacement gets its own lifecycle.
- If core reports a restart failure on a retained fork, that fork stays visibly
  failed. `retry` can restart it.
- `ready` means settled. It does not mean cleanup succeeded.

Once resolution succeeds, the lifecycle owns the actual plugin as a child fork.
It also owns an injection-waiting fork when one is requested. So the fork tree
includes this lifecycle level.

`ready` checks every descendant. This includes plugins that are still loading
after their lifecycle becomes `Active`.

Core's activation scope and supervisor generation own result publication. So a
cancelled import cannot later create a plugin under a removed or replaced entry.
Native import promises may keep running module code, but their late results are
not activated.

## Tree validation and metadata

`Tree.validate` first checks the structure of the entry tree for cycles. Then it
decodes the whole tree. The same boundary is used for file reads, edits,
writeback verification, and targets that Loader accepts.

- Unknown entry fields (such as `note`) are kept as metadata at every depth.
- Declared fields still go through Schema validation.
- `Entry.Entry` includes these extra fields as `unknown`.
- `create` and `update` accept metadata and keep their known-field types.
- A group with no `config` is normalized to `config: []`.
- An explicit `null` is invalid.
- Custom stores must validate targets before they save them.

## Snapshots

Loader owns its configuration snapshots.

- When an edit effect runs, its data is copied before it is offered to the
  queue. Later changes by the caller cannot change that queued edit.
- Initial data is captured. So are targets that store `apply` or `refresh`
  returns.
- Arrays and plain records (including metadata) are copied and recursively
  frozen. Shared references and cycles are kept.
- `entries` and `changes` expose these frozen snapshots. Do not mutate them.
- The caller's original objects stay unfrozen. If you submit them again, Loader
  captures their new values.
- Snapshots that Loader already owns can be shared without another deep copy.

Class instances (including `Env` and other Data classes) and other opaque values
keep their references. They are not frozen or cloned. Treat them as immutable
when you supply them as configuration. Mutation inside opaque values is outside
the snapshot guarantee.

Own accessor properties on plain records are captured as values when the
snapshot is made.

## Group IDs

The public `Group.Group` entry point checks sibling IDs before initial loading
and on every update. It includes disabled entries.

- Duplicate siblings fail schema decoding with `SchemaError`. They do not
  collapse into one child.
- This check is local to each group. A bad nested group can fail while healthy
  siblings run.
- Loader and Include also require IDs to be unique across the whole tree.

Group preparation uses `Tree.validateStructure` to reject cyclic topology and
`Tree.validateGroup` to decode only the current list. `Tree.GroupEntries` shares
the sibling Schema/ID rule with the public Group entry point. Wrapping a Group
in another Group does not impose global identity: separate branches may reuse an
ID. Descendant schema failures belong to their own group. Loader and Include use
`Tree.validate` to additionally decode and check IDs across the whole tree.

## Environment variables

Groups keep child descriptions without resolving their environment variables.
Only active ordinary entries resolve their own `!env` values. So a missing
variable fails that entry without stopping its siblings from loading. Disabled
entries do not resolve variables.

Configuration arrays and plain records may share values. They must not contain
cycles.

- A cyclic config or intercept fails its entry with `Entry.CyclicConfig`. It
  does not block siblings or later reconciliation.
- Other class instances are opaque values during environment resolution.
- Cycles in the entry and group topology are rejected with `InvalidOperation`.
  This happens before ID assignment or tree traversal.
- Environment resolution keeps a fresh identity cache for each execution. Shared
  containers are resolved once and stay shared. Later executions read the
  environment values again.
- Snapshot copying and cycle checks also track object identity.
- Configuration comparison visits each pair of plain containers once. It does
  not structurally hash the graph. Sharing topology does not affect value
  equality.
- Opaque values keep Effect equality, including custom equality implementations.

## File writes

Before creating a missing file, Include prepares `initial` without writing:
parse YAML, check topology, plan IDs, validate the target, then reparse and
validate the serialized result. Only the verified document is committed, in one
atomic write with all IDs present. Invalid initial entries leave the path
absent. An existing file takes precedence over `initial`.

A file write follows these steps:

1. Exclusively create a temporary file in the same directory, with mode `0600`.
2. Preserve the target's permission bits and the available uid/gid.
3. Fsync and close the file.
4. Rename it into place.

New files default to `0600`.

- Failure or interruption cleans up the temporary file. Cleanup failures are
  combined with the original Cause.
- This preserves POSIX permissions. It does not preserve extended ACLs or
  extended attributes.
- The containing directory is not fsynced. So this is not a power-loss
  durability guarantee for the rename.

Just before the rename, the writer reads the destination again. It checks that
the contents still match the version used for the edit.

- If the file changed, the writer discards the temporary file and rebases the
  edit on the new contents. It makes at most three attempts.
- If the file also changed a field that the API edit touched, the file wins. The
  edit is dropped with a warning.
- Continued contention returns `StoreError`.
- Cleanup failures keep their cause and stop retries.
- Initial creation and automatic ID writes use the same version check.

This is optimistic concurrency. An editor can still save between the final check
and the rename, and that save can be overwritten. Avoid simultaneous API edits
and editor saves when losing an overlapping save is not acceptable.

## YAML aliases and IDs

YAML edits preserve the previous values of aliases.

- Before an edit changes or removes an anchor, the affected aliases become
  independent copies.
- Editing children through an aliased group also creates a local copy. The
  source collection stays unchanged.
- Unaffected aliases stay intact.
- The final document is decoded and checked against the target before writing.
- YAML parsing and serialization failures return `StoreError` with their
  original cause.

Aliases at entry and group structure boundaries are materialized before IDs are
collected, assigned, and validated. So anonymous children in aliased groups get
distinct IDs without changing the source template. Unrelated aliases inside
ordinary plugin config stay unchanged.

Anonymous identities are matched bottom-up. Children recover their IDs before
their parent's configuration is compared. So rewriting the same anonymous tree
keeps its running instances.

- ID assignments are written to YAML only after matching completes.
- The plan includes an independent logical target.
- Before IDs are inserted, aliases that point to a changed entry or one of its
  ancestors are materialized with their original values. So an ordinary config
  alias never gets an ID just because its source entry needed one.
- The serialized document is parsed and checked against the planned target
  before commit. A mismatch returns `StoreError` and leaves the file unchanged.
- Explicit IDs are the way to keep identity across configuration changes, or
  across ambiguous rearrangements of otherwise identical entries.

## Intercepts

Config-file intercepts need explicit registration. Provide an `Intercept.layer`
in the environment used to build `Graft.layer`, before you load entries:

```ts
import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"
import { Context, Layer, Schema } from "effect"

const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})

const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.String),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const environment = Layer.merge(references, ModuleResolver.fromRecord({}))
const runtime = Layer.provideMerge(Graft.layer, environment)
```

The registry is empty by default. Group resolves `Env` values in this entry's
intercept. Then each registration does three things:

1. It decodes the patch.
2. It reads the actual reference, including its default or inherited value.
3. It calls its typed merge function.

There is no automatic object merge. For a scalar replacement, use a full-value
schema and `(_, value) => value`. Schemas must not need services for decoding.

Intercept errors:

- An unknown key fails that entry with `UnregisteredReference`.
- Invalid input fails it with `InvalidIntercept`. The schema error is kept as
  its cause.

Register references at application bootstrap. Do not publish a registry from a
plugin that this loader manages.

The stock CLI registers two references:

- `References.CurrentLogAnnotations` merges annotation fields.
- `References.MinimumLogLevel` replaces the level after validation.

Other references need registration in a custom host environment.

Environment variables in ordinary plugin config and in intercept values are
resolved inside that entry's activation. This includes nested intercept arrays
and records. The registered schema still validates the resolved value before the
merge.

- A missing variable fails the entry with `ConfigError`. Its saved target keeps
  the original `Env` values.
- Groups resolve their own intercept. Each descendant prepares itself.
- Disabled entries read no variables.

## Watching the config file

With the `watch` option of `Include`, an invalid initial document is logged with
its cause. An empty loader and the configuration watcher stay available. Saving
a valid document loads its entries without a restart.

API edits must first read and validate the file. So they cannot overwrite an
invalid document.

Without `watch`, an invalid initial document fails `Include` initialization.

## Module resolver

`ModuleResolver.make` accepts either a Promise importer or an Effect importer
that needs `Scope`. `resolve` runs in the entry lifecycle's activation scope.
Removal closes that scope and unloads its plugin children.

`resolve(name, { observationScope })` can supply a separate scope for
observation leases. The resolver passes it to the importer as the second
argument. Group owns this scope per configuration entry and uses `ScopedRef` to
replace it on retry. Failed candidates still release resources immediately,
while HMR can observe their files until retry, removal or disabling. Without
this option, the caller's scope owns observations.

Each candidate gets a child scope owned by that lifecycle. Failed attempts close
their scope before fallback is considered. The result retains both the import
failure and cleanup failure, with their original Cause reasons. Only a lone
candidate-not-found failure permits fallback. Successful candidate scopes stay
open until the entry lifecycle ends.

- After resolution succeeds, ordinary config updates, pending injections, and
  failed plugin activations keep the resolver lease.
- Restarting a lifecycle releases its old lease before it gets another. This
  includes changing config during resolution and recovering from a preparation
  failure.
- For HMR, pass `hmr.importerScoped`. Then removed entries stop taking part in
  reloads.

## Symbolic links

Include preserves symbolic links. Each disk operation resolves the configured
path and keeps that real target with the content snapshot. Reads, conflict
checks, automatic ID writes and API edits use that same target; temporary files
are created in its directory. Before rename, Include checks the configured path
again. If it points elsewhere, the temporary file is discarded and the edit is
rebased using the existing bounded retry and same-field conflict rules.

In watch mode, Include watches both the entry directory and the current target
directory. Changing the entry link triggers a fresh read and switches the target
watcher, releasing the old one. The new watcher requests another read after it
is ready. A new target with invalid YAML keeps the last valid runtime target;
fixing that file can recover it. Without watch, the next API edit reads the new
referent. Intermediate links outside the watched directories are followed on the
next read but do not themselves generate an observed notification.

A missing regular file can be initialized. A dangling, cyclic or inaccessible
link produces a typed filesystem error and is never replaced with a regular
file. Create or repair its referent before retrying; an API edit or entry
notification retries path resolution.

Resolving the path and renaming are separate filesystem operations. A link
changed after the final check can leave the in-flight edit committed to the old
target. The next read follows the new target. This has the same remaining
concurrent-save window as content checking; it is not a multi-file transaction.

## Documentation

- [Config file](https://graftland.github.io/graft/config-file/)
- [Use Graft in your program](https://graftland.github.io/graft/embedding/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
