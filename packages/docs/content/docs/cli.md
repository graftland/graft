---
title: Command line
description: The graft command and its subcommands.
---

The `@graftland/cli` package provides the `graft` command. It needs Node.js
22.19 or later, which matches its Effect Node adapter.

| Command                     | What it does                                  | Section                       |
| --------------------------- | --------------------------------------------- | ----------------------------- |
| `graft start [config]`      | Runs the application a config file describes. | [graft start](#graft-start)   |
| `graft create <directory>`  | Creates a new project.                        | [graft create](#graft-create) |
| `graft add <package...>`    | Adds dependencies and installs them.          | [graft add](#graft-add)       |
| `graft remove <package...>` | Removes dependencies.                         | [graft remove](#graft-remove) |

`graft start` also runs [`remote` entries](../remote/hosts/) with no extra
setup. To run plugins for those entries on another machine,
`@graftland/plugin-remote` installs a second command,
[`graft-remote serve --config runner.yml`](../remote/runners/#set-up-a-runner),
which starts a runner there.

## graft start

```sh
graft start [config] [--watch] [--env-file <path>]
```

Runs the application that a [config file](../config-file/) describes. `config`
defaults to `graft.yml`. The process runs until it gets
<kbd>Ctrl</kbd>+<kbd>C</kbd> or `SIGTERM`. Then it unloads every plugin in
order.

### Options

| Option              | What it does                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--watch`, `-w`     | Watches the config file and plugin modules. See [Watch mode](#watch-mode).                                 |
| `--env-file <path>` | Reads a `.env` file for [`!env`](../config-file/#environment-variables) tags. See [Env files](#env-files). |

### Env files

| Behavior       | Detail                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path           | A relative path is relative to the current directory.                                                                                                               |
| Priority       | A variable set in the process environment wins over the file, even when set to an empty string.                                                                     |
| Missing file   | The command stops.                                                                                                                                                  |
| With `--watch` | Saving the file reads it again and retries the loader, so entries whose values changed are updated. If the file cannot be read, the previous values stay in effect. |
| Scope          | The file feeds Effect's `ConfigProvider`, so both `!env` and any `Config` a plugin reads use it. It does not change `process.env`.                                  |

With `--watch`, `.env` files also use polling and watcher recovery:

| Item                | Behavior                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env` path polling | The requested path is reread every second, resolving symbolic links again. This detects saves to targets outside the config directory, link retargeting and missed notifications. |
| Changed contents    | Only changed contents retry the loader.                                                                                                                                           |
| Read failures       | Keep the last values and are logged; polling continues.                                                                                                                           |
| Watcher failures    | Logged. The watcher is installed again after one second.                                                                                                                          |

### Invalid first configuration

| Mode              | Behavior                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Without `--watch` | The CLI reports the cause and exits with a nonzero status.                                                                                                                                                                        |
| With `--watch`    | The CLI logs the first failure and waits for a valid configuration. It does not restart. The loader has no entries until it reads the first valid document, and edits through its API still cannot overwrite an invalid document. |

### Watch mode

With `--watch`, the CLI watches two kinds of change:

| Change                                                                                                | Handled by                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| YAML configuration                                                                                    | The loader. See [Changes while running](../config-file/#changes-while-running). |
| `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` and `.cts` files under the config directory (not `node_modules`) | Incremental [module reloads](../hot-reload/).                                   |

How the two interact:

- Editing YAML does not import all entries again, and does not restart every
  plugin that comes from a module. Unchanged healthy entries and their
  environment values are left alone.
- Removing or disabling an entry releases its module lease, so an invalid module
  that nobody uses cannot block reloads of other entries. Pending and failed
  entries keep their leases.
- If plugin exports that used to be shared now differ, or replacement identities
  conflict, the CLI reports the affected modules and asks for a restart. Running
  plugins stay as they are.

How the CLI drives reload:

1. It calls `hmr.watch` with a module-file filter.
2. After each attempt that ends with `Reloaded` or `Skipped`, it calls
   `loader.retry`, to retry failed entries and refresh `!env` values.
3. Reload and retry failures are logged with their complete `Cause`, and
   watching goes on.

YAML and module watchers use native filesystem notifications, without polling.
The YAML watcher rereads the file after installation to catch changes during
setup. If either watcher backend fails, the failure is logged; that watcher is
not reinstalled.

Shutdown failures are logged with their complete `Cause`. A cause combining
interruption with an error or defect is logged in full; pure interruption is
normal cancellation.

For how changes are detected, see [Hot reload](../hot-reload/#change-detection).

### Restart requirements

The CLI reports `Restart required` instead of a successful reload in two cases.
All existing plugins stay running.

| Case                                                                                           |
| ---------------------------------------------------------------------------------------------- |
| Native loading abilities (`node:module`, including `createRequire` and cached `require(esm)`). |
| A local entry or helper symlink points to a new target.                                        |

Known native-loading requirements are reported even without a file event, so a
missed startup notification cannot leave the limitation silent. Unchanged
periodic reports are suppressed. Symlink target checks are part of the periodic
check, so identical source bytes and lost native notifications cannot hide a
target change.

### Logs and intercepts

Logs are printed in a readable format. Each line a plugin writes has the
plugin's name and fork id.

The CLI registers two references for the `intercept` setting of entries,
applying to the entry and its child plugins:

| Reference                                 | Behavior                                 |
| ----------------------------------------- | ---------------------------------------- |
| `effect/References/CurrentLogAnnotations` | An object merged with outer annotations. |
| `effect/References/MinimumLogLevel`       | A replacement log level.                 |

The [config file page](../config-file/#intercepts-in-a-config-file) lists
accepted values and an example. Invalid values fail the entry with
`InvalidIntercept`. The CLI does not register other references.

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

Creates a new project in an empty or new directory.

| Created file      | What it is                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `package.json`    | The package name defaults to the directory name. It depends on the same Graft version as the command that created it. |
| `graft.yml`       | The config file. It points to the [schema](../config-file/#editor-support) of that version.                           |
| An example plugin | A starting point.                                                                                                     |
| `.gitignore`      | Ignores `node_modules` and `.env`.                                                                                    |

With `--install`, Graft installs the project's dependencies afterwards.

## graft add

```sh
graft add <package...>
```

Adds dependencies to the project in the current directory, and installs them.
Each package can have a version range, such as `graft-plugin-review@^1.2.0`.
Without one, Graft uses the latest version.

## graft remove

```sh
graft remove <package...>
```

Removes dependencies from the project in the current directory.

## Package managers

`add`, `remove` and `create --install` use the project's package manager.

Graft detects it in this order:

1. The `packageManager` field of `package.json`.
2. The lockfile.
3. The command that ran `graft`.
4. npm, if none of these say.

npm, pnpm and Yarn are supported. Yarn Plug'n'Play is not.

### Installation ownership

An install needs exclusive write access to the project until it finishes,
including recovery.

- Do not edit project files or run another installer during `add`, `remove` or
  `create --install`.
- Calls through one PackageManager run one after another. Graft does not use a
  lock against other managers, editors or processes.

### Rollback

| Situation                                   | Behavior                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The install fails or is interrupted         | Graft restores the backed-up package files byte for byte, including `package.json` and lockfiles, and removes tracked files that did not exist before. |
| Changes made during the install             | Rollback overwrites them. It does not detect conflicts or merge edits.                                                                                 |
| The project had a lockfile for this manager | Graft also tries to repair `node_modules`.                                                                                                             |
| Recovery errors                             | Reported together with the original failure.                                                                                                           |
| Process crash                               | Graft does not promise recovery.                                                                                                                       |

Managed package files must be regular files, or must not exist. Graft rejects
symbolic links, including dangling links, and other file types before the
install writes anything.

:::note

Windows is provided as is: process-tree cleanup and rollback are not verified,
and Graft does not promise them.

:::
