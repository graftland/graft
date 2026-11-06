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

`graft start` 同时支持 [remote 宿主](../remote/hosts/)和
[runner](../remote/runners/)。命令插件可以添加 `graft remote certificates`
这样的子命令，只有显式启用后才会加载。

## 命令插件

```sh
graft add --plugin remote
graft remote certificates --out ./certs --server localhost
graft add --plugin remote --global
```

`add --plugin` 安装插件包，并启用它的 `/cli`
条目。短名称会变成 registry 中存在的那一个：`@graftland/plugin-<name>` 或
`graft-plugin-<name>`；两者都存在时，请写完整包名。`--global`
将包和条目放进[用户级配置](../config-file/#命令插件)。

已启用的命令会出现在 `--help` 和 `--completions bash`
中。内置命令名和别名不能占用；重名会阻止启动。每次调用（包括帮助）只加载一次命令插件。`--no-plugins`
跳过发现，方便修复有问题的声明。发现命令时不会运行普通应用条目。

`start --watch`
遇到无效的项目配置时，暂不加载其中的命令插件，记录原因后由应用监听器等待有效文件；要加载修正后的命令条目，请重新启动 CLI。

## graft start

```sh
graft start [config] [--watch] [--env-file <path>] [--env-dir <path>] [--stdio]
```

运行[配置文件](../config-file/)中描述的应用。`config` 默认为
`graft.yml`。进程会持续运行，直到收到 <kbd>Ctrl</kbd>+<kbd>C</kbd> 或
`SIGTERM`，随后按顺序卸载所有插件。

### 协议输出

只有一个 stdio listener 的 runner 使用
`graft start runner.yml --stdio`，[MCP 服务器](../mcp-server/overview/)使用
`graft start --stdio`。加载插件、处理帮助和版本参数之前，stdout 就已保留给协议字节。日志、Console 输出（包括 worker 输出）、帮助、版本和错误都写入 stderr；此模式不提供交互向导和补全输出。runner 会拒绝不匹配的 listener 配置。stdin
EOF 后，runner 停止执行单元，确认退出后结束进程；启动或清理失败时返回非零退出码。

### 选项

| 选项                | 作用                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--watch`, `-w`     | 监听配置文件和插件模块。参见[监听模式](#监听模式)。                                                   |
| `--env-file <path>` | 读取供 [`!env`](../config-file/#环境变量) 标签使用的 `.env` 文件。参见[环境变量文件](#环境变量文件)。 |
| `--env-dir <path>`  | 读取供 `!env` 标签使用的目录，每个文件是一个变量。参见[环境变量目录](#环境变量目录)。                 |

### 环境变量文件

| 行为           | 说明                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| 路径           | 相对路径按当前目录解析。                                                                                           |
| 优先级         | 进程环境中已设置的变量优先于文件，即使值为空字符串也是如此。                                                       |
| 文件不存在     | 命令直接失败。                                                                                                     |
| 使用 `--watch` | 保存该文件会重新读取并让 loader 重试，值有变化的配置项随之更新。文件读取失败时沿用之前的值。                       |
| 作用范围       | 该文件提供给 Effect 的 `ConfigProvider`，`!env` 和插件自行读取的 `Config` 都从这里取值。它不会修改 `process.env`。 |

使用 `--watch` 时，`.env` 文件还会轮询，并在 watcher 失败后恢复：

| 项目            | 行为                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.env` 路径轮询 | 每秒重新读取请求的路径，并重新解析符号链接。因此，目标位于配置目录外、链接改指向或原生通知丢失时，也能检测变化。 |
| 内容变化        | 只有内容改变才让 loader 重试。                                                                                   |
| 读取失败        | 保留之前的值并记录错误；轮询继续。                                                                               |
| watcher 失败    | 记录错误，并在一秒后重新安装 watcher。                                                                           |

### 环境变量目录

`graft start --env-dir /run/secrets` 读取以文件形式挂载的密钥，例如 Docker
secrets 或 Kubernetes Secret 卷。

| 行为           | 说明                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| 变量           | 每个普通文件是一个变量，变量名即文件名。指向文件的符号链接也算；隐藏条目和子目录会被跳过。                  |
| 值             | 文件内容，去掉末尾的换行。空文件设置空值。                                                                  |
| 优先级         | 排在进程环境和 `--env-file` 之后。                                                                          |
| 目录不存在     | 命令直接失败。                                                                                              |
| 使用 `--watch` | 与[环境变量文件](#环境变量文件)一样监听并每秒轮询。只有值改变才让 loader 重试。目录读取失败时沿用之前的值。 |
| 路径与作用范围 | 与环境变量文件相同。                                                                                        |

### 初始配置无效

| 模式             | 行为                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 不使用 `--watch` | CLI 报告原始 cause，并以非零状态退出。                                                                                                 |
| 使用 `--watch`   | CLI 记录首次加载失败，继续等待合法配置，修正后无需重启进程。首次读到合法文档前，loader 没有配置项；通过 API 编辑时仍不能覆盖无效文档。 |

### 监听模式

使用 `--watch` 时，CLI 监听两类变化：

| 变化                                                                                    | 处理者                                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| YAML 配置                                                                               | loader。参见[在运行期间修改配置](../config-file/#在运行期间修改配置)。 |
| 配置目录下（不含 `node_modules`）的 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts` 和 `.cts` 文件 | 增量[模块重载](../hot-reload/)。                                       |

两者如何配合：

- 编辑 YAML 不会重新导入所有入口，也不会重启所有从模块加载的插件。未变的健康配置项及其环境值保持不动。
- 移除或禁用配置项会释放模块租约，因此没有人使用的无效模块不会阻塞其他入口的重载。等待依赖或失败的配置项仍保留租约。
- 原先共享的 Plugin 导出分化，或替换身份相互冲突时，CLI 会列出受影响的模块并提示重启，正在运行的插件保持不变。

CLI 如何驱动重载：

1. 它使用带模块文件过滤的 `hmr.watch`。
2. 每次重载尝试返回 `Reloaded`、`RolledBack`、`RecoveryFailed` 或 `Skipped`
   后，它会调用 `loader.retry`，重试失败项并刷新 `!env` 值。`RolledBack`
   会为每个启动失败或超时的插件记录一条警告，带有 `graft.fork` 和
   `graft.plugin`；启动失败时还带有其 `Cause`。 `RecoveryFailed`
   会将替换及恢复失败都记录为错误，带有相同注解和完整 cause，并明确指出旧代码重启失败。
3. 重载和 retry 的失败会记录完整 `Cause`，监听继续。

YAML 和模块 watcher 使用原生文件系统通知，不做轮询。YAML
watcher 安装后会重新读取文件，以捕获安装期间的变化。任一 watcher 的后端失败时，只记录错误，不会重新安装该 watcher。

关闭时的失败会记录完整
`Cause`。中断与错误或 defect 混合的 cause 会完整记录，只有纯中断才作为正常取消处理。

关于如何检测变化，请参阅[热重载](../hot-reload/#变更检测)。

### 需要重启的情况

在两种情况下，CLI 会报告
`Restart required`，而不是报告重载成功。所有现有插件保持运行。

| 情形                                                                          |
| ----------------------------------------------------------------------------- |
| 原生加载能力（`node:module`，包括 `createRequire` 和缓存的 `require(esm)`）。 |
| 本地入口或 helper 符号链接更换了目标。                                        |

已知的原生加载重启要求会在没有文件事件时主动报告，避免启动窗口漏通知后始终静默。周期性检查不会重复报告相同状态。符号链接目标也参与定期核对，因此内容相同和原生通知丢失不会隐藏目标变化。

### 日志与 intercept

日志以便于阅读的格式输出。插件写出的每行日志都带有插件名称和 fork
id。如需 JSON 输出或导出 span，请嵌入 Graft，见[在宿主中选择输出](../best-practices/observability/#在宿主中选择输出)。

CLI 为配置项的 `intercept` 设置登记了两个 Reference，对该项及其子插件生效：

| Reference                                 | 行为                   |
| ----------------------------------------- | ---------------------- |
| `effect/References/CurrentLogAnnotations` | 与外层注解合并的对象。 |
| `effect/References/MinimumLogLevel`       | 替换日志级别。         |

[配置文件页面](../config-file/#配置文件中的-intercept)列出了合法值和示例。非法值让该项以
`InvalidIntercept` 失败。CLI 不登记其他 Reference。

共享 HTTP 监听器使用普通的 `graft start` 加载 [HTTP 服务器](../http/)，不需要
`--stdio`。

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

| 模板      | 用途                                                                          | 除 `package.json` 和 `graft.yml` 外的文件                                                                                          |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | 应用。`graft.yml` 加载示例插件：`hello`，以及使用 `greeter` 服务的 `ticker`。 | `src/hello.ts`、`src/greeter.ts`、`src/ticker.ts`、`tsconfig.json`、`README.md`、`.vscode/extensions.json`、`.gitignore`           |
| `plugin`  | 要[发布](../plugins/#发布插件)的插件包。                                      | `src/index.ts`、`test/index.test.ts`、`tsconfig.json`、`tsconfig.build.json`、`README.md`、`.vscode/extensions.json`、`.gitignore` |
| `minimal` | 只有配置文件，除 `--plugin` 添加的配置项外没有其他条目。                      | `.gitignore`                                                                                                                       |

| 脚本        | `app`                 | `plugin`                                   | `minimal`             |
| ----------- | --------------------- | ------------------------------------------ | --------------------- |
| `dev`       | `graft start --watch` | `graft start --watch`，加载 `src/index.ts` | `graft start --watch` |
| `start`     | `graft start`         |                                            | `graft start`         |
| `test`      |                       | `vitest run`                               |                       |
| `typecheck` | `effect-tsgo tsc`     | `effect-tsgo tsc`                          |                       |
| `build`     |                       | 把 `src` 编译到 `dist`                     |                       |

- 每个项目依赖的 Graft 版本与该命令相同，`graft.yml`
  指向项目的[编辑器 Schema](../config-file/#编辑器支持) `./graft.schema.json`。
- Node 直接运行 `app` 的 TypeScript，因此没有构建步骤。`plugin`
  包需要构建，因为 Node 不会剥离 `node_modules` 中的类型。
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
