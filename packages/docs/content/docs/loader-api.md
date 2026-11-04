---
title: Loader API
description:
  Read and edit config entries from plugins and code, and what each edit
  guarantees.
---

The loader publishes a `Loader` service. Plugins inject it to read and edit the
entries of a [config file](../config-file/):

```ts
import { Loader } from "@graftland/loader"

const admin = Plugin.make({
	name: "admin",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			const id = yield* loader.create({ name: "./plugins/cron.mjs" })
			yield* loader.update(id, { config: { every: "5 minutes" } })
			yield* loader.update("api", { disabled: true })
		}),
})
```

## Edit entries from code

| Member                    | What it does                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `entries`                 | The latest persisted target entries.                                                           |
| `changes`                 | The current persisted target followed by accepted targets, before runtime reconciliation.      |
| `create(entry, options?)` | Adds an entry, at the end of the root list or at `position` in group `parent`. Returns its id. |
| `update(id, patch)`       | Changes some fields of an entry.                                                               |
| `remove(id)`              | Removes an entry.                                                                              |
| `ready`                   | Waits until the current target is reconciled and no fork is Loading.                           |
| `retry`                   | Retries all failed entries and refreshes `!env` values throughout the tree.                    |

Edits are written to the file. Graft keeps the file's comments, formatting and
`!env` tags.

## What an edit promises

| Stage          | Guarantee                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Admitted**   | The edit entered the loader's bounded work queue. If the caller is cancelled before this, the edit has no effect. |
| **Saved**      | The file was written and the target published. The edit's effect completes here.                                  |
| **Reconciled** | The plugins finished updating. This is **not** implied by a completed edit. Use `ready`.                          |

After admission, cancelling the caller only stops the waiting. The loader's
scoped worker continues to save the file and publish the target.

- Each caller gets the result of its operation through a `Deferred`. If the
  caller has gone away, failures are also logged with their complete cause.
- Closing the loader stops its worker, settles the pending callers, and rejects
  new edits with `LoaderClosed`.

### Waiting for results

Runtime reconciliation runs in a separate scoped fiber and may skip intermediate
targets.

| You want to…                                  | Do                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Wait for the current target and loading forks | `ready`, outside lifecycle callbacks.                                                         |
| Submit an edit from a lifecycle callback      | Do so, but never wait for `ready` there: it would wait for the callback itself.               |
| Refresh the current saved target              | `retry`, then `ready`. `retry` returns after it publishes its request.                        |
| Refresh `!env` across the whole tree          | `loader.retry`, or `loader.root.update(entries)` (also refreshes when entries are unchanged). |
| Persist configuration changes                 | The ordinary edit methods.                                                                    |

`ready` waits for the current target version, queued and executing environment
refreshes, and all loading descendants. It treats `Pending` and `Failed` forks
as settled, and a plugin can still be `Pending` for a moment after its provider
started. So `ready` does not promise that every plugin is active. The core
[`fork.stable`](../fork-handle/) barrier only describes current fork states; it
does not replace these loader checks.

About `retry`:

- `changes` also emits when `retry` publishes an unchanged target again.
- It reaches failed plugins below lifecycle, injection and group wrappers, and
  restarts the failed plugin forks.
- It keeps healthy instances and unfinished resolutions unless refreshed values
  require an update or reload.
- Ordinary edits retry failed entries in reconciled groups without refreshing
  unchanged healthy subtrees.

## Snapshots

The loader keeps a frozen snapshot of each target it accepts.

- It copies arrays and plain objects, including metadata, before it puts an API
  edit in the queue. It also copies them when it accepts the first target or a
  refreshed target.
- If you change the object you passed in, the running target and the saved
  target do not change. Submit another edit to apply the new value.
- `loader.entries` and `loader.changes` give frozen data.

| Value                                               | Treatment                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Arrays and plain objects                            | Copied. Shared references and cycles survive the snapshot, but a cycle still fails validation. |
| Class instances (`Env`, Data classes, `Date`, …)    | Keep their references. Treat them as immutable configuration.                                  |
| Shared arrays and records in environment resolution | Kept as they are, not expanded into a tree. The identity cache belongs to one execution.       |

Snapshot copying, cycle detection and config comparison also handle shared
graphs. A comparison visits each pair of plain containers once, and opaque
values keep Effect equality, including custom equality implementations. Cyclic
and opaque configs use a conservative fallback for ID matching, which can still
need quadratic work within a single same-name bucket.

## How a file is written

Graft writes to a temporary file first, so the config file is never left half
written.

1. Create the temporary file in the same directory: exclusive, mode `0600`.
2. Keep the target's permission bits and the uid/gid Graft can read. A new file
   gets `0600` by default.
3. `fsync` and close the file.
4. Rename it into place.

| Situation                         | Behavior                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| The write fails or is interrupted | Graft removes the temporary file. If that cleanup also fails, both failures are kept together. |
| Extended ACLs and attributes      | Not copied.                                                                                    |
| Power loss                        | The directory is not fsynced, so Graft does not promise that the rename survives.              |
| Parsing or serialization fails    | `StoreError` with the original cause. The file is unchanged.                                   |

Graft decodes the final document and checks it against the target before it
writes.

### YAML anchors and aliases

| Situation                                         | Behavior                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An edit changes or removes an anchor              | The aliases the edit affects become independent copies of their previous values. Others stay as they are.                                                  |
| An edit changes children through an aliased group | Graft first makes a local copy. The source collection does not change.                                                                                     |
| Aliases on the entry/group structure              | Materialized before IDs are collected and assigned, so anonymous children get their own IDs.                                                               |
| Automatic ID assignment                           | Graft computes a separate logical target, and materializes only the aliases that insertions affect. Ordinary plugin config does not inherit generated IDs. |

Graft parses the serialized YAML and checks it against the planned target. If
they differ, it returns `StoreError` and leaves the file unchanged.

## Conflicts with external edits

If someone edited the file since Graft last read it, Graft reads it again before
it applies the edit. If the edit changes a field that was also changed in the
file, **the file wins**: Graft drops the edit and logs a warning.

Graft also checks the destination right before it renames a prepared temporary
file:

1. If the file changed, Graft discards the temporary file, reads the new version
   and applies the edit again.
2. The same-field rule still uses the original snapshot, so it also catches
   changes made during preparation.
3. Graft tries at most three times. If the file keeps changing, it returns
   `StoreError` and does not commit the edit.
4. A cleanup failure stops the retries and keeps its full cause.

Creating the first file and assigning IDs automatically use the same check.

### Concurrent saves

:::caution

The content check and the rename are two separate filesystem operations. An
external editor can save between them, and that save can still be overwritten.
Atomic replacement prevents partial files; it is not a transaction with
arbitrary editors. If this remaining risk is not acceptable, do not save in an
editor and write through the API at the same time.

:::
