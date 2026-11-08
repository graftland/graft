---
title: 命令行
description: graft 命令及其子命令。
---

`@graftland/cli` 包提供 `graft` 命令。它需要 Node.js 22.19 或更高版本，与 Effect
Node 适配器的要求一致。

| 命令                        | 作用                               | 章节                          |
| --------------------------- | ---------------------------------- | ----------------------------- |
| `graft start [config]`      | 运行配置文件所描述的应用。         | [graft start](#graft-start)   |
| `graft create [directory]`  | 创建新项目。                       | [graft create](#graft-create) |
| `graft add <package...>`    | 添加依赖并安装。                   | [graft add](#graft-add)       |
| `graft remove <package...>` | 移除依赖。                         | [graft remove](#graft-remove) |
| `graft schema`              | 写入 `graft.yml` 的编辑器 Schema。 | [graft schema](#graft-schema) |
| `graft check [file]`        | 检查清单是否符合宿主要求。         | [graft check](#graft-check)   |

命令插件提供显式启用的子命令。

## 命令插件

```sh
graft add --plugin example
graft add --plugin example --global
```

`add --plugin` 安装插件包，并启用它的 `/cli`
条目。短名称会变成 registry 中存在的那一个：`@graftland/plugin-<name>` 或
`graft-plugin-<name>`；两者都存在时，请写完整包名。`--global`
将包和条目放进[用户级配置](../config-file/#命令插件)。

已启用的命令会出现在 `--help` 和 `--completions bash`
中。内置命令名和别名不能占用；重名会阻止启动。每次调用（包括帮助）只加载一次命令插件。`--no-plugins`
跳过发现，方便修复有问题的声明。发现命令时不会运行普通应用条目。

## graft start

```sh
graft start [config] [--env-file <path>] [--env-dir <path>] [--stdio]
```

运行[配置文件](../config-file/)中描述的应用。`config` 默认为
`graft.yml`。进程会持续运行，直到收到 <kbd>Ctrl</kbd>+<kbd>C</kbd> 或
`SIGTERM`，随后停止所有单元，并等待它们的退出证据。

`graft start`
进程只运行内核，不导入任何插件、命令插件或契约模块。Loader 单元读取文件的一个版本，在一次性单元里检查每个配置项，再把所有配置项作为一个[变更](../transitions/)提交。每个配置项运行在 Worker 单元里。

### 协议输出

对 [MCP 服务器](../mcp-server/overview/)使用
`graft start --stdio`。内核拥有进程的标准输入输出，并把它借给一个单元：该单元里通过
`@graftland/plugin-remote` 的 `ProcessStdio`
认领它的插件。此时标准输出只承载协议字节；日志、帮助、错误以及单元的控制台输出写到标准错误。

| 规则             | 行为                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| 唯一持有者       | 有存活的化身持有时，第二次认领以 `StdioDenied` 失败。                      |
| 重启             | 认领随持有者所在的单元结束。没有单元持有期间到达的输入会留给下一个持有者。 |
| 结束             | 持有者结束其标准输出时，内核的标准输出随之结束，`graft start` 退出。       |
| 未使用 `--stdio` | 每次认领都以 `StdioDenied` 失败。                                          |
| 放置             | Worker 和 Process 单元可以持有；runner 单元不能。                          |

### 选项

| 选项                | 作用                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--env-file <path>` | 读取供 [`!env`](../config-file/#环境变量) 标签使用的 `.env` 文件。参见[环境变量文件](#环境变量文件)。 |
| `--env-dir <path>`  | 读取供 `!env` 标签使用的目录，每个文件是一个变量。参见[环境变量目录](#环境变量目录)。                 |

### 环境变量文件

| 行为       | 说明                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 路径       | 相对路径按当前目录解析。                                                                                           |
| 优先级     | 进程环境中已设置的变量优先于文件，即使值为空字符串也是如此。                                                       |
| 文件不存在 | 命令直接失败。                                                                                                     |
| 作用范围   | 该文件提供给 Effect 的 `ConfigProvider`，`!env` 和插件自行读取的 `Config` 都从这里取值。它不会修改 `process.env`。 |

### 环境变量目录

`graft start --env-dir /run/secrets` 读取以文件形式挂载的密钥，例如 Docker
secrets 或 Kubernetes Secret 卷。

| 行为           | 说明                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| 变量           | 每个普通文件是一个变量，变量名即文件名。指向文件的符号链接也算；隐藏条目和子目录会被跳过。 |
| 值             | 文件内容，去掉末尾的换行。空文件设置空值。                                                 |
| 优先级         | 排在进程环境和 `--env-file` 之后。                                                         |
| 目录不存在     | 命令直接失败。                                                                             |
| 路径与作用范围 | 与环境变量文件相同。                                                                       |

### 初始配置无效

CLI 报告 cause，并以非零状态退出。

### 监听模式

`graft start --watch`（或
`-w`）把每次保存的编辑变成一个[变更](../transitions/)。Loader 单元监听配置文件所在的目录，但不包括
`node_modules`、`.graft`、`.cache` 和 `.git`。

| 规则     | 行为                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 变更范围 | 配置或捕获的包发生变化的配置项会被重新部署；被删除的配置项会被移除；其他配置项及其会话继续运行。           |
| 包       | 模块的制品是它所在的整个包，因此一次编辑会重新部署来自该包的所有配置项。想让插件单独重载，就给它独立的包。 |
| 时机     | 100 ms 内的多次保存合并处理。变更执行期间的保存在其后应用，且只保留最新一次。                              |
| Busy     | 以 `Busy` 被拒绝的变更会在冲突解除后再次提交。                                                             |
| 失败     | 失败的版本会被记录到日志，正在运行的配置项保持不变，下一次保存时再试。                                     |
| 不监听   | `--env-file`、`--env-dir` 和已安装的包；修改它们后请重启。                                                 |

### 需要重启的情况

环境来源或已安装包改变后需要重启。未使用 `--watch`
时，配置或代码改变后也需要重启。

### 日志与 intercept

日志以便于阅读的格式输出。插件写出的每一行都带有插件名和 fork
id。需要 JSON 输出或导出 span 时请嵌入 Graft，见[在宿主中选择输出](../best-practices/observability/#在宿主中选择输出)。

使用 `isolate`、`inject` 或 `intercept` 的配置项会在任何东西运行之前以
`DeploymentUnsupported` 拒绝。命令配置项（`cli: true`）不参与部署。

要共享 HTTP 监听器，用普通的 `graft start` 加载 [HTTP 服务器](../http/)。

## graft create

```sh
npm create @graftland@latest [directory] [-- <options>]
graft create [directory] [options]
```

创建新项目。两条命令是同一个命令。在终端中运行时，它会问几个问题，每个问题都有默认值，按
<kbd>Enter</kbd> 即可接受。使用
`--yes`，或者 stdin 或 stdout 不是终端时，它不提问，**所有问题都取默认值**。

| 选项                                  | 问题                                   | 默认值                                             |
| ------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `[directory]`                         | 在哪里创建项目。                       | `graft-app`                                        |
| `--template`、`-t`                    | 使用哪个[模板](#模板)。                | `app`                                              |
| `--name <package>`                    | 仅在 `plugin` 模板下询问。             | 目录名；`plugin` 模板为 `graft-plugin-<directory>` |
| `--plugin <package>`                  | 不询问。重复使用可添加多个插件。       | 无                                                 |
| `--package-manager <npm\|pnpm\|yarn>` | 不询问。加上 `@<version>` 会记录版本。 | 运行该命令的包管理器，否则为 npm                   |
| `--install`、`--no-install`           | 是否安装依赖。                         | 是                                                 |
| `--git`、`--no-git`                   | 是否运行 `git init`。                  | 是                                                 |
| `--yes`、`-y`                         | 所有问题取默认值。                     |                                                    |

| 规则                | 行为                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标目录            | 必须是新目录、空目录，或只含 `.git` 和 `.DS_Store`，因此在刚克隆的仓库中可以用 `.`。否则会让你换一个目录；无法提问时以 `CreateError` 失败。它从不删除或替换文件。                                                      |
| 先提问              | 所有问题都在写入任何文件之前问完。按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 会输出 `Cancelled`，以非零状态退出，磁盘上不留任何东西。                                                                                             |
| `--plugin`          | 接受 `name` 或 `name@range`，短名称的映射与 `graft add --plugin` 相同。该包写入 `dependencies`，并在 `graft.yml` 中得到一个 `- name:` 配置项。未指定范围时，Graft 自己的插件使用 Graft 的版本，其他插件使用 `latest`。 |
| `--package-manager` | 带版本时（如 `pnpm@9.15.9`）写入 `package.json` 的 `packageManager` 字段。                                                                                                                                             |
| Git                 | 只运行 `git init`，不创建首次提交。项目位于某个仓库内或未安装 git 时跳过，并说明原因。                                                                                                                                 |
| Schema              | 安装完成后，由项目自己的 `@graftland/cli` 运行 [`graft schema`](#graft-schema)。                                                                                                                                       |
| 完成之后            | 输出接下来要运行的命令，如 `cd my-app` 和 `pnpm dev`，其中包括被跳过或失败的安装、`graft schema` 和 `git init`。任一步骤失败时保留项目，并以非零状态退出。                                                             |

### 模板

| 模板      | 用途                                                                          | 除 `package.json` 和 `graft.yml` 外的文件                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | 应用。`graft.yml` 加载示例插件：`hello`，以及使用 `greeter` 服务的 `ticker`。 | `src/hello.ts`、`src/greeter.ts`、`src/ticker.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`README.zh-CN.md`、`README.zh-TW.md`、`.vscode/extensions.json`、`.gitignore` |
| `plugin`  | 要[发布](../plugins/#发布插件)的插件包。                                      | `src/index.ts`、`test/index.test.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`.vscode/extensions.json`、`.gitignore`                                                    |
| `minimal` | 只有配置文件，除 `--plugin` 添加的配置项外没有其他条目。                      | `.gitignore`                                                                                                                                                                          |

| Script      | `app`                                                                                                            | `plugin`                                                                                                         | `minimal`     |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| `dev`       | `tsc -p tsconfig.build.json && (tsc -p tsconfig.build.json --watch --preserveWatchOutput & graft start --watch)` | `tsc -p tsconfig.build.json && (tsc -p tsconfig.build.json --watch --preserveWatchOutput & graft start --watch)` |               |
| `start`     | `graft start`                                                                                                    |                                                                                                                  | `graft start` |
| `test`      |                                                                                                                  | `vitest run`                                                                                                     |               |
| `typecheck` | `effect-tsgo tsc`                                                                                                | `effect-tsgo tsc`                                                                                                |               |
| `build`     | `tsc -p tsconfig.build.json`                                                                                     | `tsc -p tsconfig.build.json`                                                                                     |               |

- 每个项目依赖的 Graft 版本与该命令相同，`graft.yml`
  指向项目的[编辑器 Schema](../config-file/#编辑器支持) `./graft.schema.json`。
- `app` 和 `plugin` 将 TypeScript 编译到
  `dist`。配置选择构建后的 JavaScript 文件，捕获的制品可在原生单元中运行。
- `.vscode/extensions.json` 推荐 YAML 扩展，它根据 schema 补全
  `graft.yml`。TypeScript 项目还会在 `typecheck` 中报告 Effect 诊断。

## graft add

```sh
graft add <package...>
graft add --plugin <name> [--global]
```

为当前目录中的项目添加依赖并安装。每个包可以指定版本范围，例如
`graft-plugin-review@^1.2.0`；未指定时使用最新版本。

## graft remove

```sh
graft remove <package...>
```

从当前目录中的项目移除依赖。

## graft schema

```sh
graft schema [--output <file>]
```

为当前目录中的项目写入 `graft.schema.json`，即 `graft.yml`
的[编辑器 Schema](../config-file/#编辑器支持)。除了随版本发布的 Schema 检查的内容，它还检查每个已安装且登记了配置的插件的
`config`。

| 情况             | 行为                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 哪些包           | `dependencies`、`devDependencies` 和 `optionalDependencies` 中，把 `@graftland/graft` 列为依赖或 peer，并导出 [`./schema`](../best-practices/packaging/#编辑器补全) 的包。 |
| 导入什么         | 只导入它们的 `./schema` 模块，不加载任何插件。                                                                                                                             |
| 依赖未安装       | 输出警告，其配置保持开放。                                                                                                                                                 |
| `./schema` 无效  | `SchemaRegistrationError` 指出是哪个包，不写入文件。                                                                                                                       |
| 保持更新         | 项目已有 `graft.schema.json` 时，`graft add` 和 `graft remove` 在安装后重写它，失败则以非零状态退出。`graft create` 会写入它。                                             |
| `--output`、`-o` | 写入的路径，默认为 `graft.schema.json`。                                                                                                                                   |

直接用包管理器安装或升级包之后，自己运行它。

## 包管理器

`add` 和 `remove` 使用项目的包管理器。`create` 使用
`--package-manager`，否则使用运行它的包管理器，再否则使用 npm。

`add` 和 `remove` 按以下顺序判断：

1. `package.json` 的 `packageManager` 字段。
2. 锁文件。
3. 运行 `graft` 的命令。
4. 以上都无法确定时使用 npm。

支持 npm、pnpm 和 Yarn，不支持 Yarn Plug'n'Play。

### 安装的独占性

从安装开始到结束（包括恢复过程），安装要求独占项目的写入权。

- 运行 `add`、`remove` 或 `create`
  的安装期间，不要编辑项目文件或运行其他安装命令。
- 同一个 PackageManager 的调用会串行执行；Graft 不会通过锁阻止其他管理器实例、编辑器或进程写入。

### 回滚

| 情形                         | 行为                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 安装失败或被中断             | Graft 逐字节恢复已备份的包管理文件，包括 `package.json` 和锁文件，并删除安装前不存在、但属于恢复范围的文件。 |
| 安装期间所做的修改           | 回滚会覆盖这些修改，不检测冲突，也不合并编辑。                                                               |
| 项目原本有当前管理器的锁文件 | Graft 还会尝试修复 `node_modules`。                                                                          |
| 恢复错误                     | 与原始失败一起报告。                                                                                         |
| 进程崩溃                     | 不承诺恢复。                                                                                                 |

受包管理器管理的文件必须是普通文件或不存在。符号链接（包括悬空链接）和其他文件类型会在安装写入前被拒绝。

:::note

Windows 按现状提供（as is）：进程树清理与回滚保证未经验证，不作承诺。

:::

## graft check

```sh
graft --no-plugins check graft.check.json
```

加载前将已发布清单与显式宿主描述进行比较。路径相对于预检文件，默认文件名为
`graft.check.json`。
[兼容性检查](../ecosystem/compatibility/)说明文件格式和诊断。检查不安装包，也不改变应用配置。

## graft remote manifest

```sh
graft remote manifest ./release
graft remote manifest ./release --check --provenance ./provenance.json
```

由已启用的 `remote/cli` 命令插件提供。从已构建声明生成或验证 `graft`
字段，并可记录包来源。发布流程见[插件清单](../ecosystem/manifest/)。
