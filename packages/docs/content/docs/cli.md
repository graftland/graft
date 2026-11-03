---
title: Command line
description: The graft command and its subcommands.
---

The `@graftland/cli` package provides the `graft` command.

## graft start

```sh
graft start [config] [--watch]
```

Runs the application described by a [config file](../config-file/). `config`
defaults to `graft.yml`. Plugins are loaded as described there, and the process
runs until it receives <kbd>Ctrl</kbd>+<kbd>C</kbd> or `SIGTERM`, which unloads
every plugin in order.

With `--watch` (`-w`), Graft picks up changes to the config file, and
[reloads plugin modules](../hot-reload/) when files in the config file's
directory change. Files in `node_modules` are ignored.

Logs are printed in a readable format. Each line written by a plugin carries the
plugin's name and fork id.

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

Creates a new project in an empty or new directory: a `package.json`, a
`graft.yml`, an example plugin and a `.gitignore`. The package name defaults to
the directory name. The project depends on the same Graft version as the command
that created it.

With `--install`, the project's dependencies are installed afterwards.

## graft add

```sh
graft add <package...>
```

Adds dependencies to the project in the current directory, and installs them.
Each package can have a version range, such as `graft-plugin-review@^1.2.0`.
Without one, the latest version is used.

## graft remove

```sh
graft remove <package...>
```

Removes dependencies from the project in the current directory.

## Package managers

`add`, `remove` and `create --install` use the project's package manager. Graft
reads it from the `packageManager` field of `package.json`, then from the
lockfile, then from the command that ran `graft`, and uses npm if none of these
say. npm, pnpm and Yarn are supported; Yarn Plug'n'Play is not.

If installing fails or is interrupted, Graft puts `package.json` and the
lockfile back as they were. If the project had a lockfile, Graft then installs
again from it, so `node_modules` matches the restored files.
