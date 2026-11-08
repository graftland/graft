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
| `graft check [file]`        | Checks manifests against a host.              | [graft check](#graft-check)   |

Command plugins add explicitly enabled subcommands.

## Command plugins

```sh
graft add --plugin example
graft add --plugin example --global
```

`add --plugin` installs the plugin package and enables its `/cli` entry. A short
name becomes whichever of `@graftland/plugin-<name>` and `graft-plugin-<name>`
the registry has; if it has both, name the package in full. `--global` installs
and enables it in the [user configuration](../config-file/#command-plugins).

Enabled commands appear in `--help` and `--completions bash`. Built-in command
names and aliases are reserved; duplicates stop startup. Commands are loaded
once per invocation, including help. `--no-plugins` skips discovery so you can
repair a broken declaration. Business entries do not run during discovery.

## graft start

```sh
graft start [config] [--env-file <path>] [--env-dir <path>] [--stdio]
```

Runs the application that a [config file](../config-file/) describes. `config`
defaults to `graft.yml`. The process runs until it gets
<kbd>Ctrl</kbd>+<kbd>C</kbd> or `SIGTERM`. Then it unloads every plugin in
order.

### Protocol output

Use `graft start --stdio` for an [MCP server](../mcp-server/overview/). Stdout
carries protocol bytes; logs, help and errors go to stderr.

### Options

| Option              | What it does                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--env-file <path>` | Reads a `.env` file for [`!env`](../config-file/#environment-variables) tags. See [Env files](#env-files). |
| `--env-dir <path>`  | Reads a directory with one file per variable for `!env` tags. See [Env directories](#env-directories).     |

### Env files

| Behavior     | Detail                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Path         | A relative path is relative to the current directory.                                                                              |
| Priority     | A variable set in the process environment wins over the file, even when set to an empty string.                                    |
| Missing file | The command stops.                                                                                                                 |
| Scope        | The file feeds Effect's `ConfigProvider`, so both `!env` and any `Config` a plugin reads use it. It does not change `process.env`. |

### Env directories

`graft start --env-dir /run/secrets` reads secrets mounted as files, such as
Docker secrets or a Kubernetes Secret volume.

| Behavior          | Detail                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Variables         | Each regular file is one variable, named after the file. Symbolic links to files count; hidden entries and subdirectories are skipped. |
| Value             | The file's contents without trailing line breaks. An empty file sets an empty value.                                                   |
| Priority          | After the process environment and `--env-file`.                                                                                        |
| Missing directory | The command stops.                                                                                                                     |
| Path and scope    | As for env files.                                                                                                                      |

### Invalid first configuration

The CLI reports the cause and exits with a nonzero status.

### Watch mode

`--watch` and `-w` are rejected. Start reads one configuration revision. Rebuild
changed modules and restart the process to apply edits.

### Restart requirements

Restart after changing configuration, environment sources or installed packages.
Directly embedded applications can use the cooperative [HMR API](../hmr-api/);
it does not provide kernel isolation or termination-based cleanup.

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

| Template  | For                                                                                                          | Files besides `package.json` and `graft.yml`                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | An application. `graft.yml` loads the example plugins: `hello`, and `ticker` using the service of `greeter`. | `src/hello.ts`, `src/greeter.ts`, `src/ticker.ts`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `README.zh-CN.md`, `README.zh-TW.md`, `.vscode/extensions.json`, `.gitignore` |
| `plugin`  | A plugin package to [publish](../plugins/#publish-a-plugin).                                                 | `src/index.ts`, `test/index.test.ts`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `.vscode/extensions.json`, `.gitignore`                                                    |
| `minimal` | Only the config file, with no entries besides those from `--plugin`.                                         | `.gitignore`                                                                                                                                                                          |

| Script      | `app`                                       | `plugin`                                    | `minimal`     |
| ----------- | ------------------------------------------- | ------------------------------------------- | ------------- |
| `dev`       | `tsc -p tsconfig.build.json && graft start` | `tsc -p tsconfig.build.json && graft start` |               |
| `start`     | `graft start`                               |                                             | `graft start` |
| `test`      |                                             | `vitest run`                                |               |
| `typecheck` | `effect-tsgo tsc`                           | `effect-tsgo tsc`                           |               |
| `build`     | `tsc -p tsconfig.build.json`                | `tsc -p tsconfig.build.json`                |               |

- Every project depends on the same Graft version as the command, and
  `graft.yml` points to its [editor schema](../config-file/#editor-support),
  `./graft.schema.json`.
- `app` and `plugin` compile TypeScript into `dist`. The config selects built
  JavaScript files so captured artifacts can run in native units.
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

## graft check

```sh
graft --no-plugins check graft.check.json
```

Checks published manifests against an explicit host before loading. Paths are
relative to the preflight file, which defaults to `graft.check.json`.
[Compatibility checks](../ecosystem/compatibility/) define the file and
diagnostics. The check does not install packages or alter the application's
configuration.

## graft remote manifest

```sh
graft remote manifest ./release
graft remote manifest ./release --check --provenance ./provenance.json
```

Provided by the enabled `remote/cli` command plugin. Generates or verifies the
`graft` field from built declarations and optionally records package provenance.
See [Plugin manifests](../ecosystem/manifest/) for the publication workflow.
