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

| This page covers                          | Read                                            |
| ----------------------------------------- | ----------------------------------------------- |
| The format of an entry                    | [Entry fields](#entry-fields)                   |
| How `name` finds a module                 | [Plugin names](#plugin-names)                   |
| Secrets and settings from the environment | [Environment variables](#environment-variables) |
| Editor completion and checks              | [Editor support](#editor-support)               |
| What happens when you save the file       | [Changes while running](#changes-while-running) |
| Editing entries from plugins or code      | [Loader API](../loader-api/)                    |

Plugins loaded from an entry can read `yield* Entry.CurrentId`, importing
`Entry` from `@graftland/loader`. This `Context.Reference<Option<string>>` holds
that entry's id, including inside nested groups, and defaults to `None` outside
entry loading. Child plugins forked by the plugin inherit it; it is not a new id
for every fork. Include persists generated ids in YAML, including plugin entry
lists, so they survive host restarts. Outside a file, missing ids derive from
the parent id, the plugin name and its occurrence among same-name entries
without ids.

## Command plugins

Declare command plugins as top-level entries:

```yaml
- name: ./dist/commands.js
  cli: true
```

These entries configure CLI commands, not application plugins. `graft start`
leaves them out of the application tree. Their `config` is passed to the command
plugin; `disabled: true` disables them. Restart the command to apply changes.
Command entries read `!env` from the process environment; `start --env-file` and
`--env-dir` apply to application entries.

| Source            | Rule                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Project           | `graft.yml` in the current directory; no ancestor search.                                                                           |
| User              | `~/.graft/graft.yml`, with packages installed in `~/.graft/node_modules`.                                                           |
| Override          | `GRAFT_HOME` replaces `~/.graft`, including both config and packages.                                                               |
| Merge             | Exact `name` matches use the project entry, including `disabled`; other entries are combined. Conflicting command names are errors. |
| Outside a project | User commands still work; a missing file contributes no entries.                                                                    |
| Paths             | Modules resolve from the declaring file’s directory. Plugins can use `ConfigDirectory` for their configuration paths.               |

Only explicitly declared modules run; Graft does not scan installed
dependencies. Use [`graft add --plugin`](../cli/#graft-add) to install and
enable one.

## Entry fields

| Field       | What it does                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Identifies the entry. If an entry has none, Graft adds one and writes it to the file, including inside a plugin's entry lists.                                                                                                                                |
| `name`      | The plugin's module: a relative path, a package name, or a short name. Groups ignore it.                                                                                                                                                                      |
| `config`    | The plugin's input. For a group, its list of entries.                                                                                                                                                                                                         |
| `disabled`  | `true` unloads the entry but keeps it in the file.                                                                                                                                                                                                            |
| `group`     | `true` makes the entry a group of other entries.                                                                                                                                                                                                              |
| `inject`    | Service keys to wait for before loading the plugin, in addition to its own `inject`.                                                                                                                                                                          |
| `isolate`   | Keys to [isolate](../isolation/): `true` for a private realm, or a label for a shared one.                                                                                                                                                                    |
| `intercept` | Schema-checked patches for registered references, applying to this entry and its descendants.                                                                                                                                                                 |
| `recording` | `{ role, scope? }` names this entry as the [recorder](../recording/). At most one entry; groups cannot hold the role. Scope defaults to every other application entry, including disabled entries.                                                            |
| `contract`  | `{ artifact, module }` selects a captured RPC contract package and a contract module within it. `artifact` is a built module path relative to this config file or absolute; use the same artifact module at both ends of a binding. Groups cannot declare it. |

### Rules

| Rule                    | Detail                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unique IDs**          | IDs must be unique across the entire Loader/Include tree, including disabled entries. Plugin entry lists and directly embedded `Group.Group` instances require uniqueness only among siblings. |
| **Same at every level** | Entry fields are decoded the same way at every nesting level.                                                                                                                                  |
| **Extra fields**        | Fields such as `note` are kept as metadata, also when you edit through the API. They do not skip the checks on declared fields.                                                                |
| **Empty groups**        | A group without `config` is an empty group (`config: []`). A group's `config` cannot be an explicit `null`.                                                                                    |
| **Keys**                | Service and reference keys are the strings their classes were created with, such as `app/Database` for `Context.Service<...>()("app/Database")`.                                               |

### Keeping identity across edits

Plugin entry lists keep their written ids when entries are inserted or
reordered. Outside a file, use explicit ids before inserting or moving same-name
siblings.

If you rewrite an anonymous tree and nothing changed, it keeps its assigned IDs
and its running plugin instances.

1. The loader restores the child IDs.
2. It matches the anonymous parent groups.
3. It writes the IDs back to YAML.

Anonymous entries are matched by name and a conservative config fingerprint,
then compared exactly. Duplicate matches retain their order.

:::tip

Use explicit IDs when you need to keep identity across config changes, or when
identical entries are moved around in a way that is unclear.

:::

### Intercepts in a config file

Config-file intercepts accept only
[explicitly registered references](../intercepts/#config-file-intercepts). The
CLI registers two for `graft schema` and embedded Loaders; `graft start` rejects
entries with `intercept` (see [graft start](../cli/#logs-and-intercepts)):

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
Sibling entries keep their own settings. Here, `Info`, `Debug` and `Trace` logs
are filtered out; `All` allows every level, and `None` turns off all logs.

| Problem            | Error                   |
| ------------------ | ----------------------- |
| Key not registered | `UnregisteredReference` |
| Invalid value      | `InvalidIntercept`      |

When you embed the loader, the registry is empty unless the host application
provides one at bootstrap.

## Plugin names

How `name` is resolved:

| `name` looks like                | Meaning                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starts with `.`                  | A path relative to the config file.                                                                                                                                                                                                                                                                                                                                 |
| Starts with `/`                  | An absolute path.                                                                                                                                                                                                                                                                                                                                                   |
| Starts with `@`, or contains `:` | Used as it is.                                                                                                                                                                                                                                                                                                                                                      |
| Anything else (such as `review`) | Tried as written, then as `@graftland/plugin-<name>` and `graft-plugin-<name>`; a module as written that exports no plugin, such as Node's `http`, is skipped. The two conventions rank equally: if both are installed, the entry fails with `AmbiguousPluginName`. Both are imported to decide, so if the second fails to import, the entry fails with that error. |

### When a module cannot be loaded

If a plugin cannot be found, or its module fails to import, the entry still
appears in the fork tree as a failed fork with the error. Graft tries again when
the entry changes.

### Entry lifecycle

Every enabled entry gets a lifecycle fork before its module starts resolving.

| Situation                           | Behavior                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Import still pending                | Counts as `Loading`. `ready` keeps waiting, but healthy siblings and later edits can go on.      |
| Entry removed, disabled or replaced | Its lifecycle is cancelled and resolver resources are released.                                  |
| Config changes during resolution    | A new attempt starts. Unchanged entries keep their current attempt.                              |
| Late result from a cancelled import | Cannot activate the old entry again. The native import promise itself may still run module code. |
| Resolution succeeds                 | The lifecycle creates the real plugin as a child fork. `ready` checks this whole subtree.        |

Pending service injections and failed forks still count as settled.

Effect importers acquire resources in a separate scope for each specifier
spelling they try:

- A failed spelling is released before trying the next one.
- A cleanup failure prevents fallback and is kept together with the import
  failure.
- The resources of the spelling that loads remain owned by the entry lifecycle.

## Environment variables

`!env NAME` reads an environment variable when the entry is loaded.

- The file keeps the tag, so secrets are never written into it.
- If the variable is not set, the entry fails until you fix it.
- `graft start --env-file .env` also reads variables from a `.env` file; the
  process environment wins. `--env-dir` reads mounted secret files the same way.
  See [the command line](../cli/#graft-start).

### Types and secrets

`!env` gives a string. The plugin's config schema decides what it becomes. The
person who writes the config file chooses which variable to read; the plugin
only describes the value it needs.

| Schema                                    | Result                   |
| ----------------------------------------- | ------------------------ |
| `Schema.NumberFromString`                 | A number.                |
| `Schema.RedactedFromValue(Schema.String)` | A secret that logs hide. |

A plugin that wants Effect's `Config` tools, such as defaults and fallbacks, can
use them inside `apply` to read its own input:

```ts import.meta.vitest name="config-file: read the input with Config"
import { Config, ConfigProvider, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

const readSettings = (input: unknown) =>
	Settings.parse(ConfigProvider.fromUnknown(input))

export default Plugin.make({
	name: "app/server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* readSettings(input)
			yield* Effect.log(`Listening on port ${settings.port}`)
		}),
})

Effect.runSync(readSettings({ port: "3000" })) // => { port: 3000 }
Effect.runSync(readSettings({})) // => { port: 8080 }
```

The plugin's schema still describes what the entry accepts. `Config` values that
a plugin reads from the ambient provider by itself are not `!env` tags, so a
refresh does not know about them and does not read them again.

### Where tags work

- In ordinary plugin `config` and in `intercept` values, also inside nested
  arrays and records.
- An entry resolves its intercept first. The registered schema then decodes and
  merges it, and the resolved values must still pass that schema.
- A group resolves its own intercept, not the descriptions of its descendants,
  and it does not resolve its children's variables early.
- Disabled entries do not resolve variables.
- If an active child lacks a variable, only that child fails. Its group and
  siblings are not affected.
- The saved target and the file keep the original tags.

### When values are read again

| Trigger                          | Which entries read variables again                                               |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Ordinary API edit or YAML change | Only changed entries. Unchanged healthy siblings and subtrees keep their values. |
| `loader.root.update(entries)`    | The whole tree, including nested groups and injection gates.                     |

After an explicit refresh:

- A running entry whose resolved config changed gets the new config through
  `update`.
- An entry whose resolved intercept changed is loaded again.
- Entries whose values did not change keep running.
- An entry that is still importing reads the environment when the import ends.
  If a refresh reaches an entry that is still loading, it reads them again once
  it is active.
- `ready` waits for these queued and executing refreshes too, so after an
  explicit refresh and `ready`, every active entry has the current values.

### Cycles

Arrays and plain records may share config values, but they cannot contain
cycles.

| Where the cycle is           | Result                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| In a config or intercept     | The entry fails with `CyclicConfig`. Siblings and later edits can go on. |
| In the entry/group structure | Rejected with `InvalidOperation`, before ID assignment and loading.      |

Environment resolution treats other class instances as opaque.

## Editor support

[`graft schema`](../cli/#graft-schema) writes `graft.schema.json`, the JSON
Schema of this file for the plugins your project installs. Point the YAML
language server to it with a comment on the first line, and editors such as VS
Code (with the YAML extension) can complete and check the entries:

```yaml title="graft.yml"
# yaml-language-server: $schema=./graft.schema.json
- id: api
  name: ./plugins/api.mjs
```

| Schema                                                    | Checks                                                                                                                                                                        | Kept current by                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `graft.schema.json`                                       | Entry fields, registered intercepts, and the `config` of every installed plugin that exports a [registration](../best-practices/packaging/#editor-completion), in groups too. | `graft create`, and `graft add` and `graft remove` when the file exists.            |
| `@graftland/cli/schema.json`, released with every version | Entry fields and registered intercepts. The `config` of every plugin, Graft's own included, stays open.                                                                       | Its version, as in `https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json`. |

- `graft create` points `graft.yml` to `./graft.schema.json`, and writes the
  file once dependencies are installed.
- Commit `graft.schema.json`, so editors check entries right after a clone.
- Run `graft schema` yourself after installing or upgrading packages with the
  package manager directly.
- Config without a registration stays open; its plugin's schema checks it at
  startup.

The language server may flag `!env`. Declare the tag in the editor settings. For
VS Code:

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## Changes while running

With `graft start --watch`, each save becomes a Change; see
[Watch mode](../cli/#watch-mode). The editing and watcher rules below describe
directly embedded Include and Loader APIs; they provide cooperative lifecycle
behavior. Include merges file and physical-target notifications, debounces them
for 100 ms and requests a catch-up read after watcher installation.

Graft then compares the new entries with the running entries:

| Change                                                      | Result                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `config` changed                                            | New input through [`update`](../fork-handle/). The plugin updates in place or restarts. |
| `name`, `group`, `inject`, `isolate` or `intercept` changed | Unloaded and loaded again.                                                              |
| New entry                                                   | Loaded.                                                                                 |
| Removed or disabled entry                                   | Unloaded.                                                                               |
| Unchanged healthy entry                                     | Keeps running with its existing environment values.                                     |
| Failed entry in a reconciled group                          | Retried. Unchanged resolutions still in progress keep their activation.                 |

### Concurrency

- Independent sibling updates and removals run concurrently.
- Work for each entry remains serialized, and replacement waits for that entry's
  old cleanup.
- The group waits for all required work before accepting the target.
- Delayed environment refreshes share the group's serial reconciliation executor
  with ordinary edits. They cannot interrupt an update callback to apply a newer
  target.
- Requests for removed or superseded entry generations are discarded.

### Cleanup failures

If cleanup fails while Graft removes, disables or replaces an entry, Graft logs
the complete cause with the entry and fork identifiers, then continues
reconciling.

- The removed fork is disposed. A replacement has its own separate lifecycle.
- If a restart fails on a fork that stays, the failure remains visible as
  `Failed`, and you can retry it.
- Failures of resolver observation resources and lifecycle cleanup are recorded
  together, without restarting healthy siblings.
- `ready` counts failed forks as settled. It does not promise that cleanup
  worked.

### Invalid files

An invalid first file fails CLI startup. The following rules apply to embedded
Include.

| Situation                          | Behavior                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| Invalid file while running         | Graft logs the error and keeps the last valid version.       |
| API edit while the file is invalid | Cannot replace the invalid file with an empty configuration. |

When embedding Include with `initial`, a missing file is created only after YAML
preparation, ID assignment, full-tree validation and serialization verification
succeed. The complete document is committed once. Invalid initial entries leave
the file absent, and an existing file takes precedence over `initial`.

## Symbolic links

Include preserves symbolic links. Each disk operation resolves the configured
path and keeps that real target with the content snapshot. Reads, conflict
checks, automatic ID writes and API edits use that same target; temporary files
are created in its directory.

| Situation                                      | Behavior                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Link changes before rename                     | The temporary file is discarded and the edit is rebased with the bounded retry and same-field conflict rules.                       |
| Watch mode                                     | Include watches both the entry directory and the current target directory.                                                          |
| Entry link changes                             | A fresh read, and the target watcher switches: the old one is released, and the new one requests another read when ready.           |
| New target has invalid YAML                    | The last valid runtime target stays; fixing the file recovers it.                                                                   |
| Without watch                                  | The next API edit reads the new referent.                                                                                           |
| Intermediate links outside watched directories | Followed on the next read, but they generate no notification themselves.                                                            |
| Missing regular file                           | Can be initialized.                                                                                                                 |
| Dangling, cyclic or inaccessible link          | A typed filesystem error. It is never replaced with a regular file. Repair the referent; an API edit or entry notification retries. |

:::caution

Resolving the path and renaming are separate filesystem operations. A link
changed after the final check can leave the in-flight edit committed to the old
target; the next read follows the new target. This is the same concurrent-save
window as in the [Loader API](../loader-api/#concurrent-saves). It is not a
multi-file transaction.

:::
