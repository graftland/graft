---
name: migrate-cordis-app
description:
  Use when moving an application that runs on cordis to Graft, including
  `cordis.yml` and its entries, `!!js` expressions, the `cordis` start command,
  `@cordisjs/plugin-*` packages (loader, include, hmr, timer, logger, fs), or a
  host that builds `new Context()`.
---

# Migrate a cordis application to Graft

An application is the config file, the plugins it names, and the host that
starts them. This skill moves all three. Porting an individual plugin's source
is the [`migrate-cordis-plugin`](../migrate-cordis-plugin/SKILL.md) skill; reach
for it from step 2 whenever a plugin has no Graft version. Running and debugging
the migrated app is the [`graft`](../graft/SKILL.md) skill.

## Version gate

- Source: cordis 4.x with `@cordisjs/plugin-loader` and
  `@cordisjs/plugin-include` (`cordis.yml`).
- Target: `@graftland/cli`, `@graftland/loader` and `@graftland/graft` of one
  release, `effect` 4.1.x, Node.js 22.19 or later.

## Steps

### 1. Inventory

Collect:

- Every config file: `cordis.yml` and any file loaded through
  `@cordisjs/plugin-include` entries.
- Every entry, with its `name`, and every `!!js` tag in it.
- Every cordis-related dependency in `package.json`: `cordis`, `@cordisjs/*`,
  `cordis-plugin-*`, and the application's own plugin modules.
- How the app starts: the `cordis` bin, scripts, or host code that calls
  `new Context()` and `ctx.plugin(...)`.

Done when every entry and every dependency appears in one table.

### 2. Classify every plugin

Give each table row exactly one class:

| Class                             | Rows                                                                                                                                 | Action                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Host-provided**                 | `plugin-loader`, `plugin-include`, `plugin-hmr`, `plugin-logger-console`, `plugin-fs-node`, `plugin-timer`, `plugin-package-manager` | Delete the entry; the replacement is listed in [Host replacements](#host-replacements). |
| **Has a Graft version**           | A published Graft plugin exists (`@graftland/plugin-<name>`, `graft-plugin-<name>`, or one the user names)                           | Swap the dependency and adapt `config` to its schema.                                   |
| **Own code**                      | Plugin modules in the application                                                                                                    | Port with `migrate-cordis-plugin`.                                                      |
| **Third-party, no Graft version** | Everything else                                                                                                                      | Ask the user: port it, replace it, or drop it.                                          |

Check the registry before assigning **third-party, no Graft version**
(`npm view <name>`); do not assume a package exists. Done when every row has a
class and every **third-party** row has the user's decision.

### 3. Translate the config file

Rename `cordis.yml` to `graft.yml` and translate each entry with
[references/config-file.md](references/config-file.md). Done when no `!!js` tag
and no cordis service name remains, and every `inject`, `isolate` and
`intercept` key is a Graft key string.

### 4. Replace the host

- **CLI apps:** `cordis` → `graft start` (see
  [Host replacements](#host-replacements)). Add `--watch` for development
  instead of a `plugin-hmr` entry, and `--env-file .env` where the app read a
  `.env` file.
- **Embedded apps:** replace `new Context()` + `ctx.plugin(Loader)` with a
  `Graft.layer` runtime that loads `Include.Include`; see
  [references/config-file.md](references/config-file.md#embedding).
- Update `package.json`: remove cordis dependencies, add `@graftland/cli` (or
  `@graftland/graft` + `@graftland/loader` when embedded) and `effect`;
  `graft add` / `graft remove` do this and install.

### 5. Verify

1. Run `graft start` (no `--watch`) and confirm it starts: an invalid first
   configuration exits with a nonzero status and the cause.
2. Confirm every entry is `Active`. Entries left `Pending` name the missing
   service keys; entries left `Failed` carry the cause.
3. Run the application's own checks (typecheck, tests).

Report anything not `Active` with its cause; that is the remaining migration
work.

## Host replacements

| cordis                                               | Graft                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `cordis` bin / `@cordisjs/plugin-loader` + `include` | `graft start [graft.yml]`                                                                                                          |
| `@cordisjs/plugin-hmr` entry                         | `graft start --watch` (development only)                                                                                           |
| `@cordisjs/plugin-logger-console`                    | Built into `graft start` (pretty console logger). Log level per entry via `intercept: { effect/References/MinimumLogLevel: Warn }` |
| `@cordisjs/plugin-fs-node` (`ctx.fs`)                | Effect `FileSystem` / `Path`, provided by `graft start`                                                                            |
| `@cordisjs/plugin-timer` (`ctx.timer`)               | Effect `Clock`, `Schedule`, `Effect.sleep`; nothing to load                                                                        |
| `@cordisjs/plugin-package-manager`                   | `graft add <pkg>` / `graft remove <pkg>`                                                                                           |
| `@cordisjs/create`                                   | `npm create @graftland` or `graft create [dir]` (useful as a reference layout)                                                     |
| `ctx.loader.create / update / remove`                | The `Loader` service from `@graftland/loader`: `create`, `update`, `remove`, `ready`, `retry`                                      |

## Behavior differences to tell the user

- **Config files never run code.** `!!js` is gone; `!env NAME` is the only tag.
- **Unknown fields are kept** as metadata, and Graft writes generated `id`s back
  into the file.
- **A broken plugin does not stop the app.** It appears as a `Failed` fork and
  retries when its entry changes or new code arrives.
- **Hot reload is all-or-nothing per save**: if any affected module fails to
  import, the old plugins keep running.
