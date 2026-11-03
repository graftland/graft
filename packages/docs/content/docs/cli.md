---
title: Command line
description: The graft command and its subcommands.
---

The CLI needs Node.js 22.19 or later. This matches its Effect Node adapter.

The `@graftland/cli` package provides the `graft` command.

## graft start

```sh
graft start [config] [--watch] [--env-file <path>]
```

Runs the application that a [config file](../config-file/) describes. `config`
defaults to `graft.yml`. Plugins load as that page describes. The process runs
until it gets <kbd>Ctrl</kbd>+<kbd>C</kbd> or `SIGTERM`. Then it unloads every
plugin in order.

`--env-file` names a `.env` file for
[`!env`](../config-file/#environment-variables) tags. A relative path is
relative to the current directory. A variable set in the process environment
wins over the file, even when it is set to an empty string. If the file is
missing, the command stops. With `--watch`, saving the file reads it again and
retries the loader. So entries whose values changed are updated. If the file
cannot be read, the previous values stay in effect. The file feeds Effect's
`ConfigProvider`. Both `!env` and any `Config` that a plugin reads use it. The
file does not change `process.env`, so libraries that read `process.env`
directly do not see it.

Watch mode also rereads the requested path every second, resolving symbolic
links again each time. This detects saves to targets outside the config
directory, link retargeting, and missed native notifications. Only changed
contents retry the loader. Read failures keep the last values and are logged;
polling continues. Native watcher failures are logged and retried, and shutdown
logs any cleanup failure with its complete cause.

Without `--watch`, the CLI reports an invalid first configuration with its
cause, and the command exits with a nonzero status. With `--watch`, the CLI logs
the first failure and waits for a valid configuration. It does not restart. The
loader is available with no entries until it reads the first valid document.
Edits through its API still validate the file and cannot overwrite an invalid
document.

With `--watch` (`-w`), the loader watches YAML configuration changes on its own.
Only actual content or local resolution changes in observed `.js`, `.mjs`,
`.cjs`, `.ts`, `.mts`, and `.cts` files under the config directory start
incremental [module reloads](../hot-reload/). This includes subdirectories.
Files in `node_modules` are ignored. Editing YAML does not import all entries
again, and it does not restart every plugin that comes from a module. Ordinary
YAML edits leave unchanged healthy entries and their environment values alone.
If you remove or disable a configuration entry, it releases its module lease. So
an invalid module that nobody uses any more cannot block reloads of other
entries. Pending and failed entries keep their leases. Polling follows these
leases too. It keeps failed import attempts for retry, and it drops entries and
exclusive dependencies after their last owner closes. Suppose plugin exports
that used to be shared now differ. Or suppose replacement identities conflict
with each other or with existing aliases. Then the CLI reports the affected
modules and asks for a restart. The running plugins stay as they are.

Failed first imports keep an observation lease owned by the configuration entry,
separate from the candidate resource scope that closes immediately on failure.
Fixing the module can therefore recover through polling even when the native
notification is lost. Retry replaces the observation generation; removal or
disabling closes it.

The CLI uses `hmr.watch` with a module-file filter. Native events request
content checks; only actual changes trigger incremental reloads of affected
entries, with shared modules kept consistent. Metadata and local resolutions are
checked once per second, using a stat fast path. While idle, content audits run
at least every ten seconds to catch missed events, including changes with the
same size and timestamps. HMR installs nonrecursive directory watches from its
observed graph instead of traversing unrelated directories. After each reload
attempt that ends with `Reloaded` or `Skipped`, the CLI calls `loader.retry` to
retry failed entries and refresh `!env` values throughout the tree. Reload and
retry failures are logged with their complete cause, and watching goes on.
Watcher I/O failures are also logged, and the watcher is installed again after
one second. Shutdown failures are also observed. A cause that combines
interruption with an error or defect is logged in full. Pure interruption is
normal cancellation. HMR also records native import failures that finish after
cancellation was requested, before interruption can hide them.

Logs are printed in a readable format. Each line that a plugin writes has the
plugin's name and fork id. The CLI registers
`effect/References/CurrentLogAnnotations` (an object merged with outer
annotations) and `effect/References/MinimumLogLevel` (a replacement log level)
for the `intercept` settings of entries. These apply to the entry and its child
plugins. The [config-file reference](../config-file/#entry-fields) lists
accepted values and an example. Invalid values fail the entry with
`InvalidIntercept`. The CLI does not register other references.

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

Creates a new project in an empty or new directory. It makes a `package.json`, a
`graft.yml`, an example plugin and a `.gitignore`. The package name defaults to
the directory name. The project depends on the same Graft version as the command
that created it. `graft.yml` points to the
[schema](../config-file/#editor-support) of that version.

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

`add`, `remove` and `create --install` use the project's package manager. Graft
finds it in the `packageManager` field of `package.json`. If that is missing, it
looks at the lockfile, then at the command that ran `graft`. If none of these
say, Graft uses npm. npm, pnpm and Yarn are supported. Yarn Plug'n'Play is not.

An install needs exclusive write access to the project until it finishes,
including recovery. Do not edit project files or run another installer during
`add`, `remove` or `create --install`. Calls through one PackageManager run one
after another. Graft does not use a lock against other managers, editors or
processes.

If the install fails or is interrupted, Graft restores the backed-up package
files byte for byte. This includes `package.json` and lockfiles. It also removes
tracked files that did not exist before the install. Rollback overwrites changes
made during the install. It does not detect conflicts or merge edits.

If the project had a lockfile for the selected package manager, Graft also tries
to repair `node_modules`. Recovery errors are reported together with the
original failure. Graft does not promise recovery after a process crash.

Managed package files must be regular files, or must not exist. Graft rejects
symbolic links, including dangling links, and other file types before the
install writes anything. Windows is provided as is: process-tree cleanup and
rollback are not verified, and Graft does not promise them.

### Restart requirements in watch mode

The CLI reports `Restart required` instead of a successful reload in two cases.
The first is native loading abilities (`node:module`, including `createRequire`
and cached `require(esm)`). The second is local entry or helper symlinks that
point to a new target. All existing plugins stay running. Symlink target checks
are also part of the periodic check. So identical source bytes and lost native
notifications cannot hide a target change.

Known native-loading requirements are reported even without a file event, so a
missed startup notification cannot leave the limitation silent. Unchanged
periodic reports are suppressed.
