---
title: Config file
description: Describe an application in graft.yml, and edit it while it runs.
---

`graft start` reads a YAML file, `graft.yml` by default. The file is a list of
entries, and each entry loads one plugin:

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL

- id: api
  name: ./plugins/api.mjs
  config:
    port: 8080

- id: tenants
  name: tenants
  group: true
  isolate:
    app/Database: true
  config:
    - id: tenant-db
      name: "@acme/graft-plugin-postgres"
      config:
        url: !env TENANT_DATABASE_URL
```

IDs must be unique across the entire Loader/Include tree, including disabled
entries. Directly embedded `Group.Group` instances instead require uniqueness
only among siblings; adding a surrounding group does not change that rule.

## Entry fields

| Field       | What it does                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- |
| `id`        | Identifies the entry. If an entry has none, Graft adds one and writes it to the file.         |
| `name`      | The plugin's module: a relative path, a package name, or a short name. Groups ignore it.      |
| `config`    | The plugin's input. For a group, its list of entries.                                         |
| `disabled`  | `true` unloads the entry but keeps it in the file.                                            |
| `group`     | `true` makes the entry a group of other entries.                                              |
| `inject`    | Service keys to wait for before loading the plugin, in addition to its own `inject`.          |
| `isolate`   | Keys to [isolate](../isolation/): `true` for a private realm, or a label for a shared one.    |
| `intercept` | Schema-checked patches for registered references, applying to this entry and its descendants. |

Entry fields are decoded the same way at every nesting level. Extra fields such
as `note` are kept as metadata, also when you edit through the API. They do not
skip the checks on declared fields. A group without `config` is an empty group
(`config: []`). A group's `config` cannot be an explicit `null`.

The loader keeps a frozen snapshot of each target it accepts. It copies arrays
and plain objects, including metadata, before it puts an API edit in the queue.
It also copies them when it accepts the first target or a refreshed target. If
you change the object you passed in, the running target and the saved target do
not change. To apply the new value, submit another edit. `loader.entries` and
`loader.changes` give frozen data.

When you embed the loader, class instances keep their references. Examples are
`Env`, other Data classes, `Date`, and other opaque values. The loader does not
copy or freeze their insides, so treat them as immutable configuration. Arrays
and plain objects may share references, and the snapshot keeps this sharing.
Cycles also survive the snapshot, but a cycle still fails validation at the
existing entry or tree boundary. Environment resolution keeps shared arrays and
plain records as they are. It does not expand them into a tree. Its identity
cache belongs to one execution, so an entry reads environment values again when
it is activated or updated. An unrelated edit does not refresh unchanged healthy
entries. Snapshot copying, cycle detection and config comparison also handle
shared graphs. A comparison visits each pair of plain containers once. Opaque
values keep Effect equality, including custom equality implementations.

If you rewrite an anonymous tree and nothing changed, it keeps its assigned IDs
and its running plugin instances. The loader first restores the child IDs, then
matches the anonymous parent groups, then writes the IDs back to YAML. Use
explicit IDs when you need to keep identity across config changes, or when
identical entries are moved around in a way that is unclear. Anonymous entries
are matched by name and a conservative config fingerprint, then compared
exactly. Duplicate matches retain their order. Cyclic and opaque configs use a
conservative fallback, which can still require quadratic work within a single
same-name bucket.

Service and reference keys are the strings their classes were created with, such
as `app/Database` for `Context.Service<...>()("app/Database")`.

Config-file intercepts accept only
[explicitly registered references](../isolation/#config-file-intercepts). Each
registration gives three things: the Reference object, a Schema for the
configured patch, and a typed merge function. The loader decodes the patch, then
merges it with the outer value. If there is no outer override, it merges with
the Reference's default. The registration chooses whether to merge objects. It
is not automatic.

An unregistered key fails the entry with `UnregisteredReference`. Invalid input
fails it with `InvalidIntercept`, and the schema error stays as its cause. The
plugin's `apply` does not run. When you embed the loader, the registry is empty
unless the host application gives one at bootstrap. `graft start` gives these
two registrations:

| Reference key                             | Configured value                                                     | Behavior                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `effect/References/CurrentLogAnnotations` | An object                                                            | Shallowly merges with outer annotations; configured keys win.    |
| `effect/References/MinimumLogLevel`       | `All`, `Fatal`, `Error`, `Warn`, `Info`, `Debug`, `Trace`, or `None` | Replaces the outer minimum log level. Values are case-sensitive. |

```yaml title="graft.yml"
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

This entry and its child plugins inherit the annotations and the log level.
Sibling entries keep their own settings. In this example, `Info`, `Debug`, and
`Trace` logs are filtered out. `All` allows every level, and `None` turns off
all logs. Other references need an explicit registration in a custom host.

## Plugin names

A `name` that starts with `.` is a path relative to the config file, and one
that starts with `/` is an absolute path. A name that starts with `@` or
contains `:` is used as it is. Any other name is tried as written, then as
`@graftland/plugin-<name>`, then as `graft-plugin-<name>`. Packages are resolved
from the application directory.

If a plugin cannot be found, or its module fails to import, the entry still
appears in the fork tree. It shows as a failed fork with the error. Graft tries
to load it again when its entry changes, or when [hot reload](../hot-reload/)
picks up new code.

Every enabled entry gets a lifecycle fork before its module starts resolving. An
import that is still pending counts as `Loading`. `ready` keeps waiting, but
healthy siblings and later edits can still go on. If you remove, disable or
replace the entry, its lifecycle is cancelled and the resolver resources are
released. A config change during resolution starts a new attempt. Unchanged
entries keep their current attempt. A late result from a cancelled import cannot
activate the old entry again. The native import promise itself may still run
module code.

When resolution succeeds, the lifecycle creates the real plugin as a child fork.
`ready` checks this whole subtree, so an active lifecycle cannot hide a plugin
that is still loading. Pending service injections and failed forks still count
as settled.

Effect importers acquire resources in a separate scope for each module
candidate. A failed candidate is released before trying the next name. Cleanup
failure prevents fallback and is retained alongside the import failure. A
successful candidate's resources remain owned by the entry lifecycle.

## Environment variables

`!env NAME` reads an environment variable when the entry is loaded. The file
keeps the tag, so secrets are never written into it. If the variable is not set,
the entry fails until you fix it.

`!env` gives a string. The plugin's config schema decides what it becomes. A
schema such as `Schema.NumberFromString` turns it into a number.
`Schema.RedactedFromValue(Schema.String)` wraps a secret so that logs hide it.
The person who writes the config file chooses which variable to read. The plugin
only describes the value it needs.

`graft start --env-file .env` also reads variables from a `.env` file. The
process environment wins. See [the command line](../cli/#graft-start) for
details.

Ordinary API edits and YAML changes reconcile only changed entries. Unchanged
healthy siblings and subtrees keep their current environment values; editing one
leaf does not refresh the whole tree.

`loader.retry` and `loader.root.update(entries)` explicitly refresh `!env`
values throughout the tree, including nested groups and injection gates. A
running entry whose resolved config changed gets the new config through
`update`. An entry whose resolved intercept changed is loaded again. Entries
whose values did not change keep running. An entry that is still importing its
module reads the environment when the import ends. If a retry reaches an entry
that is still loading, the entry reads them again once it is active. `ready`
waits for these queued and executing refreshes too, so after an explicit refresh
and `ready`, every active entry has the current values.

A plugin that wants Effect's `Config` tools, such as defaults and fallbacks, can
use them inside `apply` to read its own input:

```ts
const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

export default Plugin.make({
	name: "server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* Settings.parse(ConfigProvider.fromUnknown(input))
			// ...
		}),
})
```

The plugin's schema still describes what the entry accepts. If a plugin reads
`Config` values from the ambient provider by itself, those are not `!env` tags.
`retry` does not know about them and does not reload them.

Tags work in ordinary plugin `config` and in `intercept` values, also inside
nested arrays and records. An entry resolves its intercept first. Then the
registered Schema decodes and merges it. The resolved values must still pass
that schema. A group resolves its own intercept, not the descriptions of its
descendants. The saved target and the file keep the original tags.

A group keeps the descriptions of its children. It does not resolve their
environment variables early. Disabled entries do not resolve variables. If an
active child lacks a variable, only that child fails. Its group and its siblings
are not affected.

Arrays and plain records may share config values, but they cannot contain
cycles. A config or intercept with a cycle fails its entry with `CyclicConfig`.
Its siblings and later edits can still go on. Environment resolution treats
other class instances as opaque. A cycle in the entry/group structure itself is
rejected with `InvalidOperation`, before ID assignment and loading.

## Editor support

Every Graft release includes a JSON Schema for this file. It has the same
version as the release. Add a comment on the first line to point the YAML
language server to it. Then editors such as VS Code (with the YAML extension)
can complete and check the entry fields:

```yaml title="graft.yml"
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json
- id: api
  name: ./plugins/api.mjs
```

Replace `1.2.3` with the version of `@graftland/cli` in your project. Update it
when you upgrade Graft. `graft create` writes this line with its own version.
The schema is also in the package as `@graftland/cli/schema.json`.

The schema checks the entry fields and the intercepts that `graft start`
registers. It does not check a plugin's `config`, because only the plugin's own
Schema knows its shape. The language server may flag `!env`. To stop that,
declare the tag in the editor settings. For VS Code:

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## Changes while running

With `graft start --watch`, Graft watches the config file. When you save it,
Include merges notifications from the entry and physical-target watchers and
waits for 100 ms without another notification before refreshing. Installing a
watcher still requests a catch-up read, including after a symlink target
changes. Graft then compares the new entries with the running entries:

- An entry whose `config` changed gets the new input through
  [`update`](../lifecycle/#the-fork-handle). The plugin updates in place or
  restarts.
- An entry whose `name`, `group`, `inject`, `isolate` or `intercept` changed is
  unloaded and loaded again.
- New entries are loaded, and removed or disabled entries are unloaded.
- Unchanged healthy entries keep running with their existing environment values.
- Failed entries in a reconciled group are retried; unchanged resolutions that
  are still in progress keep their activation.

Independent sibling updates and removals run concurrently. Work for each entry
remains serialized, and replacement waits for that entry's old cleanup. The
group waits for all required work before accepting the target.

If cleanup fails while Graft removes, disables or replaces an entry, Graft logs
the complete cause with the entry and fork identifiers. Then it continues the
reconciliation. The removed fork is disposed. A replacement has its own separate
lifecycle. If a restart fails on a fork that stays, the failure remains visible
as `Failed`, and you can retry it. `ready` counts failed forks as settled. It
does not promise that cleanup worked.

This includes cleanup of resolver observation resources: their failure and
lifecycle cleanup failure are recorded together without restarting healthy
siblings. Delayed environment refreshes share the group's serial reconciliation
executor with ordinary edits. They cannot interrupt an update callback to apply
a newer target. Requests for removed or superseded entry generations are
discarded, and `ready` waits for outstanding refresh work.

If the file is not valid, Graft logs the error and keeps running the last valid
version. If the first file is invalid in watch mode, Graft logs the cause and
starts with no entries. It keeps watching. When you fix the file, its entries
load by themselves. API edits cannot replace the invalid file with an empty
configuration. Without watch mode, an invalid first configuration makes startup
fail.

When embedding Include with `initial`, a missing file is created only after YAML
preparation, ID assignment, full-tree validation and serialization verification
succeed. The complete document is committed once. Invalid initial entries leave
the file absent; an existing file takes precedence over `initial`.

## Edit entries from code

The loader publishes a `Loader` service. Plugins can inject it to read and edit
the entries:

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
`!env` tags. It writes to a temporary file first, so the config file is never
left half written.

Graft creates the temporary file in the same directory. The creation is
exclusive and uses mode `0600`. Graft keeps the target's permission bits and the
uid/gid it can read. It then fsyncs and closes the file, and renames it into
place. A new file gets `0600` by default. If the write fails or is interrupted,
Graft removes the temporary file. If that cleanup also fails, the cleanup
failure is kept together with the original cause. Extended ACLs and extended
attributes are not copied. The directory is not fsynced, so Graft does not
promise that the rename survives a power loss.

Before an edit changes or removes a YAML anchor, the aliases that the edit
affects become independent copies of their previous values. Other aliases stay
as they are. If you edit children through an aliased group, Graft first makes a
local copy. The source collection does not change. Graft decodes the final
document and checks it against the target before it writes. If parsing or
serialization fails, Graft returns `StoreError` with the original cause and
leaves the file unchanged.

Aliases on the entry/group structure are materialized before IDs are collected
and assigned. So anonymous children in an aliased group get their own IDs. The
source template does not change, and neither do unrelated aliases in ordinary
plugin config. For automatic ID assignment, Graft first computes a separate
logical target. Before it inserts IDs, it materializes the aliases that the
insertions affect, with their original values. So ordinary plugin config does
not inherit generated IDs. Graft parses the serialized YAML and checks it
against the planned target before it writes. If they differ, it returns
`StoreError` and leaves the file unchanged.

An edit is admitted when it enters the loader's bounded work queue. If you
cancel the caller before admission, the edit has no effect. After admission,
cancelling only stops the waiting. The loader's scoped worker continues to save
the file and publish the target. Each caller gets the result of its operation
through a Deferred. If the caller has gone away, failures are also logged with
their complete cause. Closing the loader stops its worker, settles the pending
callers, and rejects new edits with `LoaderClosed`.

Runtime reconciliation runs in a separate scoped fiber. It may skip intermediate
targets. When an edit completes, its target was saved and published. This does
not mean the plugins have finished updating. Outside lifecycle callbacks, use
`ready` to wait for the current target and its loading forks. A callback may
submit edits, but it must not wait for `ready`, because that would wait for the
callback itself. `changes` also emits when `retry` publishes an unchanged target
again. `retry` reaches failed plugins below lifecycle, injection and group
wrappers, and restarts the failed plugin forks. It keeps healthy instances and
unfinished resolutions unless refreshed values require an update or reload.
Ordinary edits retry failed entries in reconciled groups without refreshing
unchanged healthy subtrees. `retry` returns after it publishes its request. To
wait for reconciliation, call `ready` after it, outside lifecycle callbacks.

If someone edited the file since Graft last read it, Graft reads it again before
it applies the edit. Suppose the edit changes a field that was also changed in
the file. Then the file wins: Graft drops the edit and logs a warning.

Graft also checks the contents of the destination right before it renames a
prepared temporary file. If the file has changed, Graft discards the temporary
file, reads the new version and applies the edit again. The rule for conflicts
on the same field still uses the original snapshot, so it also catches changes
made during preparation. Graft tries at most three times. If the file keeps
changing, Graft returns `StoreError` and does not commit the API edit. A cleanup
failure stops the retries and keeps its full cause. Creating the first file and
assigning IDs automatically use the same check.

**Concurrent-save limitation:** the content check and the rename are two
separate filesystem operations. An external editor can save between them, and
that save can still be overwritten. Atomic replacement prevents partial files.
It is not a transaction with arbitrary editors. If this remaining risk is not
acceptable, do not save in an editor and write through the API at the same time.

`loader.root.update(entries)` is also an explicit full-tree environment refresh,
including when the supplied entries are unchanged. Use `loader.retry` to refresh
the current saved target, and the ordinary edit methods to persist configuration
changes.

`ready` waits for the current target version, queued and executing environment
refreshes, and all loading descendants. The core
[`fork.stable`](../lifecycle/#the-fork-handle) barrier only describes current
fork states; it does not replace these loader coordination checks.

`ready` treats `Pending` and `Failed` forks as settled. A plugin can still be
`Pending` for a moment after its provider started. So `ready` does not promise
that every plugin is active.

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
