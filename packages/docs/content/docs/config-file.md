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

## Entry fields

| Field       | What it does                                                                               |
| ----------- | ------------------------------------------------------------------------------------------ |
| `id`        | Identifies the entry. Graft adds one, and writes it to the file, if an entry has none.     |
| `name`      | The plugin's module: a relative path, a package name, or a short name. Ignored for groups. |
| `config`    | The plugin's input. For a group, its list of entries.                                      |
| `disabled`  | `true` unloads the entry but keeps it in the file.                                         |
| `group`     | `true` makes the entry a group of other entries.                                           |
| `inject`    | Service keys to wait for before loading the plugin, in addition to its own `inject`.       |
| `isolate`   | Keys to [isolate](../isolation/): `true` for a private realm, or a label for a shared one. |
| `intercept` | Reference values for this entry and everything below it, by reference key.                 |

Service and reference keys are the strings their classes were created with, such
as `app/Database` for `Context.Service<...>()("app/Database")`.

An `intercept` value replaces the outer value. If both are objects, their fields
are merged instead, with this entry's fields winning.

## Plugin names

A `name` that starts with `.` is a path relative to the config file, and one
that starts with `/` is an absolute path. A name that starts with `@` or
contains `:` is used as it is. Any other name is tried as written, then as
`@graftland/plugin-<name>`, then as `graft-plugin-<name>`. Packages are resolved
from the application directory.

If a plugin cannot be found, or its module fails to import, the entry still
appears in the fork tree as a failed fork with the error. It is loaded again
when its entry changes, or when [hot reload](../hot-reload/) picks up new code.

## Environment variables

`!env NAME` reads an environment variable when the entry is loaded. The file
keeps the tag, so secrets never end up in it. If the variable is not set, the
entry fails until it is fixed.

## Changes while running

With `graft start --watch`, Graft watches the config file. When you save it,
Graft compares the new entries with the running ones:

- An entry whose `config` changed gets the new input through
  [`update`](../lifecycle/#the-fork-handle). The plugin updates in place or
  restarts.
- An entry whose `name`, `group`, `inject`, `isolate` or `intercept` changed is
  unloaded and loaded again.
- New entries are loaded, and removed or disabled entries are unloaded.
- Entries that did not change keep running.

If the file is not valid, Graft logs the error and keeps the last valid version
running.

## Edit entries from code

The loader publishes a `Loader` service that plugins can inject to read and edit
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
| `entries`                 | The current entries.                                                                           |
| `changes`                 | A stream of the current entries and every change.                                              |
| `create(entry, options?)` | Adds an entry, at the end of the root list or at `position` in group `parent`. Returns its id. |
| `update(id, patch)`       | Changes some fields of an entry.                                                               |
| `remove(id)`              | Removes an entry.                                                                              |
| `ready`                   | Waits until no fork in the tree is still loading.                                              |
| `retry`                   | Loads again every entry whose plugin or config could not be resolved.                          |

Edits are written to the file. Graft keeps the file's comments, formatting and
`!env` tags, and writes to a temporary file first, so the config file is never
left half written.

If someone edited the file since Graft last read it, Graft reads it again before
applying the edit. When the edit changes a field that was also changed in the
file, the file wins: Graft drops the edit and logs a warning.

`ready` does not wait for plugins that depend on each other to settle: a plugin
can still be `Pending` for a moment after its provider started.
