---
title: Command line
description: The graft command and its subcommands.
---

The `@graftland/cli` package provides the `graft` command. It needs Node.js
22.19 or later, which matches its Effect Node adapter.

| Command                     | What it does                                  | Section                       |
| --------------------------- | --------------------------------------------- | ----------------------------- |
| `graft start [config]`      | Runs the application a config file describes. | [graft start](#graft-start)   |
| `graft create [directory]`  | Creates a new project.                        | [graft create](#graft-create) |
| `graft add <package...>`    | Adds dependencies and installs them.          | [graft add](#graft-add)       |
| `graft remove <package...>` | Removes dependencies.                         | [graft remove](#graft-remove) |
| `graft schema`              | Writes the editor schema of `graft.yml`.      | [graft schema](#graft-schema) |

`graft start` runs both [remote hosts](../remote/hosts/) and
[runners](../remote/runners/). Command plugins add subcommands such as
`graft remote certificates`; they run only when explicitly enabled.

## Command plugins

```sh
graft add --plugin remote
graft remote certificates --out ./certs --server localhost
graft add --plugin remote --global
```

`add --plugin` installs the plugin package and enables its `/cli` entry. A short
name becomes whichever of `@graftland/plugin-<name>` and `graft-plugin-<name>`
the registry has; if it has both, name the package in full. `--global` installs
and enables it in the [user configuration](../config-file/#command-plugins).

Enabled commands appear in `--help` and `--completions bash`. Built-in command
names and aliases are reserved; duplicates stop startup. Commands are loaded
once per invocation, including help. `--no-plugins` skips discovery so you can
repair a broken declaration. Business entries do not run during discovery.

With `start --watch`, an invalid project config temporarily contributes no
command plugins. The CLI logs the cause and the application watcher waits for a
valid file; restart the CLI to load its command entries.

## graft start

```sh
graft start [config] [--watch] [--env-file <path>] [--env-dir <path>] [--stdio]
```

Runs the application that a [config file](../config-file/) describes. `config`
defaults to `graft.yml`. The process runs until it gets
<kbd>Ctrl</kbd>+<kbd>C</kbd> or `SIGTERM`. Then it unloads every plugin in
order.

### Protocol output

Use `graft start runner.yml --stdio` for a runner with one stdio listener, and
`graft start --stdio` for an [MCP server](../mcp-server/overview/). The flag
reserves stdout for protocol bytes before loading plugins or parsing help and
version flags. Logs, Console output (including worker output), help, version and
errors go to stderr; interactive wizard and completion output are unavailable in
this mode. The runner rejects a mismatched listener configuration. At stdin EOF
it stops its execution units, confirms termination and exits; startup or cleanup
failure gives a nonzero exit.

### Options

| Option              | What it does                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--watch`, `-w`     | Watches the config file and plugin modules. See [Watch mode](#watch-mode).                                 |
| `--env-file <path>` | Reads a `.env` file for [`!env`](../config-file/#environment-variables) tags. See [Env files](#env-files). |
| `--env-dir <path>`  | Reads a directory with one file per variable for `!env` tags. See [Env directories](#env-directories).     |

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

### Env directories

`graft start --env-dir /run/secrets` reads secrets mounted as files, such as
Docker secrets or a Kubernetes Secret volume.

| Behavior          | Detail                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Variables         | Each regular file is one variable, named after the file. Symbolic links to files count; hidden entries and subdirectories are skipped.                                   |
| Value             | The file's contents without trailing line breaks. An empty file sets an empty value.                                                                                     |
| Priority          | After the process environment and `--env-file`.                                                                                                                          |
| Missing directory | The command stops.                                                                                                                                                       |
| With `--watch`    | Watched and polled every second like [env files](#env-files). Only changed values retry the loader. If the directory cannot be read, the previous values stay in effect. |
| Path and scope    | As for env files.                                                                                                                                                        |

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
2. After each attempt that ends with `Reloaded`, `RolledBack` or `Skipped`, it
   calls `loader.retry`, to retry failed entries and refresh `!env` values.
   `RolledBack` logs one warning per plugin that failed to start or timed out,
   with `graft.fork` and `graft.plugin`, and the `Cause` of a failure.
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
plugin's name and fork id. For JSON output or exported spans, embed Graft; see
[Choose the output in your host](../best-practices/observability/#choose-the-output-in-your-host).

The CLI registers two references for the `intercept` setting of entries,
applying to the entry and its child plugins:

| Reference                                 | Behavior                                 |
| ----------------------------------------- | ---------------------------------------- |
| `effect/References/CurrentLogAnnotations` | An object merged with outer annotations. |
| `effect/References/MinimumLogLevel`       | A replacement log level.                 |

The [config file page](../config-file/#intercepts-in-a-config-file) lists
accepted values and an example. Invalid values fail the entry with
`InvalidIntercept`. The CLI does not register other references.

For a shared HTTP listener, load [HTTP server](../http/) with ordinary
`graft start`; it does not need `--stdio`.

## graft create

```sh
npm create @graftland@latest [directory] [-- <options>]
graft create [directory] [options]
```

Creates a new project. Both commands are the same command. In a terminal it asks
a few questions, each with a default you accept by pressing <kbd>Enter</kbd>.
With `--yes`, or when stdin or stdout is not a terminal, it asks nothing and
**every question takes its default**.

| Option                                | Question                                  | Default                                                     |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `[directory]`                         | Where to create the project.              | `graft-app`                                                 |
| `--template`, `-t`                    | Which [template](#templates).             | `app`                                                       |
| `--name <package>`                    | Asked only for `plugin`.                  | The directory name; `graft-plugin-<directory>` for `plugin` |
| `--plugin <package>`                  | Not asked. Repeat it for more plugins.    | None                                                        |
| `--package-manager <npm\|pnpm\|yarn>` | Not asked. Add `@<version>` to record it. | The package manager that runs the command, otherwise npm    |
| `--install`, `--no-install`           | Whether to install dependencies.          | Yes                                                         |
| `--git`, `--no-git`                   | Whether to run `git init`.                | Yes                                                         |
| `--yes`, `-y`                         | Takes every default.                      |                                                             |

| Rule                | Behavior                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target directory    | Must be new, empty, or hold only `.git` and `.DS_Store`, so `.` works in a freshly cloned repository. Otherwise it asks for another directory, or fails with `CreateError` when it cannot ask. It never removes or replaces a file.     |
| Questions first     | Every question comes before anything is written. <kbd>Ctrl</kbd>+<kbd>C</kbd> prints `Cancelled`, exits with a nonzero status and leaves nothing on disk.                                                                               |
| `--plugin`          | Takes `name` or `name@range`; short names map as in `graft add --plugin`. The package goes into `dependencies` and gets a `- name:` entry in `graft.yml`. Without a range, Graft's own plugins use Graft's version and others `latest`. |
| `--package-manager` | A version, as in `pnpm@9.15.9`, is written to the `packageManager` field of `package.json`.                                                                                                                                             |
| Git                 | `git init` only, without a first commit. Skipped, with the reason, when the project is inside a repository or git is not installed.                                                                                                     |
| Schema              | After installing, the project's own `@graftland/cli` runs [`graft schema`](#graft-schema).                                                                                                                                              |
| Afterwards          | Prints the commands to run next, such as `cd my-app` and `pnpm dev`, including an install, `graft schema` or `git init` that was skipped or failed. A failed step keeps the project and exits with a nonzero status.                    |

### Templates

| Template  | For                                                                                                          | Files besides `package.json` and `graft.yml`                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | An application. `graft.yml` loads the example plugins: `hello`, and `ticker` using the service of `greeter`. | `src/hello.ts`, `src/greeter.ts`, `src/ticker.ts`, `tsconfig.json`, `README.md`, `.vscode/extensions.json`, `.gitignore`           |
| `plugin`  | A plugin package to [publish](../plugins/#publish-a-plugin).                                                 | `src/index.ts`, `test/index.test.ts`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `.vscode/extensions.json`, `.gitignore` |
| `minimal` | Only the config file, with no entries besides those from `--plugin`.                                         | `.gitignore`                                                                                                                       |

| Script      | `app`                 | `plugin`                                      | `minimal`             |
| ----------- | --------------------- | --------------------------------------------- | --------------------- |
| `dev`       | `graft start --watch` | `graft start --watch`, loading `src/index.ts` | `graft start --watch` |
| `start`     | `graft start`         |                                               | `graft start`         |
| `test`      |                       | `vitest run`                                  |                       |
| `typecheck` | `effect-tsgo tsc`     | `effect-tsgo tsc`                             |                       |
| `build`     |                       | Compiles `src` to `dist`                      |                       |

- Every project depends on the same Graft version as the command, and
  `graft.yml` points to its [editor schema](../config-file/#editor-support),
  `./graft.schema.json`.
- Node runs the TypeScript of `app` directly, so it has no build step. A
  `plugin` package is built, because Node does not strip types inside
  `node_modules`.
- `.vscode/extensions.json` recommends the YAML extension, which completes
  `graft.yml` from its schema. The TypeScript projects also report Effect
  diagnostics in `typecheck`.

## graft add

```sh
graft add <package...>
graft add --plugin <name> [--global]
```

Adds dependencies to the project in the current directory, and installs them.
Each package can have a version range, such as `graft-plugin-review@^1.2.0`.
Without one, Graft uses the latest version.

## graft remove

```sh
graft remove <package...>
```

Removes dependencies from the project in the current directory.

## graft schema

```sh
graft schema [--output <file>]
```

Writes `graft.schema.json`, the [editor schema](../config-file/#editor-support)
of `graft.yml`, for the project in the current directory. Besides what the
released schema checks, it checks the `config` of every installed plugin that
registers one.

| Case                          | Behavior                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which packages                | Those in `dependencies`, `devDependencies` and `optionalDependencies` that list `@graftland/graft` as a dependency or peer and export [`./schema`](../best-practices/packaging/#editor-completion). |
| What is imported              | Only their `./schema` modules. No plugin is loaded.                                                                                                                                                 |
| A dependency is not installed | A warning. Its config stays open.                                                                                                                                                                   |
| A `./schema` is not valid     | `SchemaRegistrationError` names the package, and no file is written.                                                                                                                                |
| Kept current                  | `graft add` and `graft remove` rewrite `graft.schema.json` after installing when the project has one, and exit with a nonzero status if that fails. `graft create` writes it.                       |
| `--output`, `-o`              | The path to write. Defaults to `graft.schema.json`.                                                                                                                                                 |

Run it yourself after installing or upgrading packages with the package manager
directly.

## Package managers

`add` and `remove` use the project's package manager. `create` uses
`--package-manager`, otherwise the package manager that runs it, otherwise npm.

`add` and `remove` detect it in this order:

1. The `packageManager` field of `package.json`.
2. The lockfile.
3. The command that ran `graft`.
4. npm, if none of these say.

npm, pnpm and Yarn are supported. Yarn Plug'n'Play is not.

### Installation ownership

An install needs exclusive write access to the project until it finishes,
including recovery.

- Do not edit project files or run another installer during `add`, `remove` or
  the install of `create`.
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
