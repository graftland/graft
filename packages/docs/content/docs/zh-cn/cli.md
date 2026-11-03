---
title: 命令行
description: graft 命令及其子命令。
---

`@graftland/cli` 包提供 `graft` 命令。

## graft start

```sh
graft start [config] [--watch]
```

运行[配置文件](../config-file/)中描述的应用。`config` 默认为
`graft.yml`。插件按文件中的配置加载，进程会持续运行，直到收到
<kbd>Ctrl</kbd>+<kbd>C</kbd> 或 `SIGTERM`，随后按顺序卸载所有插件。

使用
`--watch`（`-w`）时，Graft 会监听配置文件的变化，并在配置文件所在目录中的文件变化时[重载插件模块](../hot-reload/)。`node_modules`
中的文件会被忽略。

日志以便于阅读的格式输出。插件写出的每行日志都带有插件名称和 fork id。

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

在空目录或新目录中创建项目，包括 `package.json`、`graft.yml`、示例插件和
`.gitignore`。包名默认为目录名。项目依赖的 Graft 版本与创建它的命令版本相同。

使用 `--install` 时，创建后会安装项目依赖。

## graft add

```sh
graft add <package...>
```

为当前目录中的项目添加依赖并安装。每个包可以指定版本范围，例如
`graft-plugin-review@^1.2.0`；未指定时使用最新版本。

## graft remove

```sh
graft remove <package...>
```

从当前目录中的项目移除依赖。

## 包管理器

`add`、`remove` 和 `create --install` 使用项目的包管理器。Graft 依次从
`package.json` 的 `packageManager` 字段、锁文件以及运行 `graft`
的命令中判断包管理器；都无法确定时使用 npm。支持 npm、pnpm 和 Yarn，不支持 Yarn
Plug'n'Play。

如果安装失败或被中断，Graft 会将 `package.json`
和锁文件恢复原状。如果项目原本有锁文件，Graft 会再根据它重新安装，使
`node_modules` 与恢复后的文件一致。
