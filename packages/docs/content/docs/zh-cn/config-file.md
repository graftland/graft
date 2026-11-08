---
title: 配置文件
description: 用 graft.yml 描述应用，并在运行期间修改配置。
---

`graft start` 读取 YAML 文件，默认是
`graft.yml`。文件内容是一个配置项列表，每项加载一个插件：

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

| 本页内容                 | 阅读                                      |
| ------------------------ | ----------------------------------------- |
| 配置项的格式             | [配置项字段](#配置项字段)                 |
| `name` 如何找到模块      | [插件名称](#插件名称)                     |
| 来自环境的密钥和设置     | [环境变量](#环境变量)                     |
| 编辑器补全和检查         | [编辑器支持](#编辑器支持)                 |
| 保存文件时会发生什么     | [在运行期间修改配置](#在运行期间修改配置) |
| 从插件或代码中编辑配置项 | [Loader API](../loader-api/)              |

从条目加载的插件可从 `@graftland/loader` 导入 `Entry`，读取
`yield* Entry.CurrentId`。它是
`Context.Reference<Option<string>>`，值为当前条目的 id，嵌套 group 中也一样；不经过条目加载时默认为
`None`。插件内部 fork 的子插件会继承它，不会为每个 fork 生成新 id。Include 会把生成的 id 保存到 YAML，包括插件的条目列表，供宿主重启后继续使用。不使用文件时，缺失的 id 由父项 id、插件名称及其在未指定 id 的同名条目中的次序决定。

## 命令插件

在顶层声明命令插件条目：

```yaml
- name: ./dist/commands.js
  cli: true
```

这些条目配置 CLI 命令，`graft start` 不会把它们加载到应用树中。 `config`
传给命令插件，`disabled: true` 禁用条目。修改后重新运行命令即可生效。命令条目的
`!env` 读取进程环境；`start --env-file` 和 `--env-dir` 只作用于应用条目。

| 来源     | 规则                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 项目     | 当前目录的 `graft.yml`，不向父目录查找。                                           |
| 用户     | `~/.graft/graft.yml`，包安装在 `~/.graft/node_modules`。                           |
| 覆盖目录 | `GRAFT_HOME` 替换 `~/.graft`，同时改变配置和包的目录。                             |
| 合并     | `name` 完全相同时以项目条目为准，包括 `disabled`；其他条目合并。命令名冲突时报错。 |
| 项目之外 | 用户级命令仍可使用；缺失的配置文件视为空列表。                                     |
| 路径     | 模块以声明所在的配置文件目录为准；插件可通过 `ConfigDirectory` 解析配置里的路径。  |

只有显式声明的模块会运行，不扫描已安装依赖。可用
[`graft add --plugin`](../cli/#graft-add) 一次完成安装和启用。

## 配置项字段

| 字段        | 作用                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `id`        | 标识配置项。如果未指定，Graft 会生成一个并写回文件，插件内的条目列表也一样。    |
| `name`      | 插件模块，可以是相对路径、包名或短名称。分组会忽略此字段。                      |
| `config`    | 插件的输入；对于分组，则是其配置项列表。                                        |
| `disabled`  | 设为 `true` 时卸载该项，但保留在文件中。                                        |
| `group`     | 设为 `true` 时，该项成为包含其他配置项的分组。                                  |
| `inject`    | 加载插件前需要等待的服务键，作为插件自身 `inject` 声明的补充。                  |
| `isolate`   | 需要[隔离](../isolation/)的键。`true` 表示私有领域（realm），标签表示共享领域。 |
| `intercept` | 经过 Schema 校验的已登记 Reference 配置补丁，对该项及其后代生效。               |

### 规则

| 规则           | 说明                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **ID 唯一**    | Loader/Include 要求整棵条目树的 ID 唯一，包括禁用项。插件的条目列表和直接嵌入的 `Group.Group` 则只要求同层兄弟项 ID 唯一。    |
| **各层级相同** | 所有嵌套层级的配置项字段都遵循相同的解码规则。                                                                                |
| **额外字段**   | `note` 等额外字段作为元数据保留，API 编辑时也是如此。它们不会绕过对已声明字段的校验。                                         |
| **空分组**     | 分组省略 `config` 时，按空分组（`config: []`）处理；分组的 `config` 不能显式设为 `null`。                                     |
| **键**         | 服务键和 Reference 键是创建它们时使用的字符串。例如，`Context.Service<...>()("app/Database")` 对应的服务键是 `app/Database`。 |

### 跨编辑保持身份

插件的条目列表在插入或重排条目时保留已写入的 id。不使用文件时，插入或移动同名条目前请显式指定 id。

重新写入未变化的匿名配置树时，已分配的 ID 和运行中的插件实例保持不变。

1. 加载器先恢复子项 ID。
2. 再匹配匿名父分组。
3. 最后将 ID 写回 YAML。

匿名配置项先按名称和保守的配置指纹筛选，再精确比较；重复匹配项保持原顺序。

:::tip

如果需要跨配置变化保持身份，或需要区分重新排列的相同条目，请显式指定 ID。

:::

### 配置文件中的 intercept

配置文件中的 intercept 只接受[显式登记的 Reference](../intercepts/#配置文件中的-intercept)。`graft start`
默认登记了两项：

| Reference 键                              | 配置值                                                              | 行为                                       |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `effect/References/CurrentLogAnnotations` | 对象                                                                | 与外层日志注解浅合并，同名键以配置值为准。 |
| `effect/References/MinimumLogLevel`       | `All`、`Fatal`、`Error`、`Warn`、`Info`、`Debug`、`Trace` 或 `None` | 替换外层最低日志级别，区分大小写。         |

```yaml title="graft.yml"
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

该项及其子插件继承日志注解和级别，兄弟配置项保持各自的设置。此例会过滤
`Info`、`Debug` 和 `Trace` 日志；`All` 允许所有级别，`None` 关闭所有日志。

| 问题     | 错误                    |
| -------- | ----------------------- |
| 键未登记 | `UnregisteredReference` |
| 值无效   | `InvalidIntercept`      |

嵌入 loader 时，登记表默认为空，需要宿主应用在启动时提供。

## 插件名称

`name` 的解析方式：

| `name` 的形式           | 含义                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 以 `.` 开头             | 相对于配置文件的路径。                                                                                                                                                                                                                                                                 |
| 以 `/` 开头             | 绝对路径。                                                                                                                                                                                                                                                                             |
| 以 `@` 开头，或包含 `:` | 直接使用。                                                                                                                                                                                                                                                                             |
| 其他（例如 `review`）   | 先尝试原名称，再尝试 `@graftland/plugin-<name>` 和 `graft-plugin-<name>`；原名称对应的模块若没有导出插件（例如 Node 的 `http`），会被跳过。两种命名约定地位相同：两者都已安装时，该条目以 `AmbiguousPluginName` 失败。判断时两者都会被导入，因此第二个导入失败时，该条目以该错误失败。 |

### 模块无法加载时

如果找不到插件或模块导入失败，该配置项仍会出现在 fork 树中，显示为带错误的失败 fork。当配置项变化，或[热重载](../hot-reload/)检测到新代码时，会再次尝试加载。

### 配置项的生命周期

每个启用的配置项都会先创建生命周期 fork，再开始模块解析。

| 情形                     | 行为                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| 导入尚未完成             | 计为 `Loading`。`ready` 会继续等待，但健康兄弟项和后续编辑仍能推进。 |
| 配置项被删除、禁用或替换 | 取消其生命周期并释放解析器资源。                                     |
| 解析期间修改配置         | 启动新一轮解析；未变化的配置项保留当前解析过程。                     |
| 已取消导入的迟到结果     | 不会重新激活旧条目。原生 import Promise 本身仍可能继续执行模块代码。 |
| 解析成功                 | 生命周期将实际插件作为子 fork 创建。`ready` 检查这整棵子树。         |

等待服务注入的 Pending fork 和 Failed fork 仍视为已稳定。

Effect importer 的每个模块候选都有独立的子 scope 来取得资源：

- 候选失败后，先释放其资源，再尝试下一个名称。
- 清理失败会阻止回退，并与导入失败的 cause 一并保留。
- 成功候选的资源由配置项的生命周期持续持有。

## 环境变量

`!env NAME` 在加载配置项时读取环境变量。

- 文件中保留原始标签，因此密钥不会被写入文件。
- 如果变量未设置，该项会失败，直到问题修复。
- `graft start --env-file .env` 还会从 `.env`
  文件读取变量；进程环境变量优先。`--env-dir`
  以同样的方式读取挂载的密钥文件。详见[命令行](../cli/#graft-start)。

### 类型与密钥

`!env`
得到的是字符串，最终变成什么由插件的配置 Schema 决定。读取哪个变量由编写配置文件的人决定，插件只描述自己需要的值。

| Schema                                    | 结果                 |
| ----------------------------------------- | -------------------- |
| `Schema.NumberFromString`                 | 数字。               |
| `Schema.RedactedFromValue(Schema.String)` | 日志中会隐藏的密钥。 |

插件如果想用 Effect `Config` 的组合子（例如默认值和备选来源），可以在 `apply`
里用它们读取自己的输入：

```ts import.meta.vitest name="config-file: read the input with Config"
import { Config, ConfigProvider, Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

const readSettings = (input: unknown) =>
	Settings.parse(ConfigProvider.fromUnknown(input))

export default Plugin.make({
	name: "app/server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* readSettings(input)
			yield* Effect.log(`Listening on port ${settings.port}`)
		}),
})

Effect.runSync(readSettings({ port: "3000" })) // => { port: 3000 }
Effect.runSync(readSettings({})) // => { port: 8080 }
```

插件的 Schema 仍然描述配置项接受什么。插件自行从环境中的 provider 读取的
`Config` 不是 `!env` 标签，`retry` 不知道它们，也不会重新加载。

### 标签在哪里有效

- 普通插件的 `config` 和 `intercept` 值均支持该标签，包括嵌套数组和对象。
- 配置项先解析自身的 intercept，再由已登记的 Schema 解码并合并；解析后的值仍须通过该 Schema 校验。
- 分组只解析自身的 intercept，不解析后代的描述，也不提前解析子项的变量。
- 禁用项不解析变量。
- 启用的子项缺少变量时，只让该子项失败，不影响其分组和兄弟项。
- 已持久化目标和文件均保留原始标签。

### 何时重新读取

| 触发条件                                        | 重新读取变量的配置项                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| 普通 API 编辑或 YAML 变化                       | 只有变化的配置项。未变的健康兄弟项和子树保留现有值。 |
| `loader.retry` 或 `loader.root.update(entries)` | 整棵树，包括嵌套分组和注入门控下的子项。             |

显式刷新之后：

- 运行中配置项的解析结果变了，会通过 `update` 接收新配置。
- 解析后的 intercept 变了，则重新加载该项。
- 值未变的配置项继续运行。
- 仍在导入模块的项会在导入完成后读取环境变量；刷新请求到达时若仍在加载，会在激活后再读一次。
- `ready` 也会等待排队中和执行中的刷新，因此显式刷新后再等待
  `ready`，所有活跃项都已使用当前值。

### 环

数组和普通对象可以共享配置值，但不能成环。

| 环出现的位置           | 结果                                                   |
| ---------------------- | ------------------------------------------------------ |
| config 或 intercept 中 | 该项以 `CyclicConfig` 失败，兄弟项和后续编辑仍可继续。 |
| 条目/分组结构中        | 在分配 ID 和加载前以 `InvalidOperation` 拒绝。         |

环境变量解析将其他类实例视为不透明值。

## 编辑器支持

[`graft schema`](../cli/#graft-schema) 写入
`graft.schema.json`，即针对项目所安装插件的这个文件的 JSON
Schema。在文件第一行用注释把 YAML language server 指向它，VS
Code（装有 YAML 扩展）等编辑器就能补全和检查配置项：

```yaml title="graft.yml"
# yaml-language-server: $schema=./graft.schema.json
- id: api
  name: ./plugins/api.mjs
```

| Schema                                       | 检查内容                                                                                                                               | 保持更新的方式                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `graft.schema.json`                          | 配置项字段、已登记的 intercept，以及每个导出[登记项](../best-practices/packaging/#编辑器补全)的已安装插件的 `config`，group 内也一样。 | `graft create`；文件存在时还有 `graft add` 和 `graft remove`。                   |
| `@graftland/cli/schema.json`，随每个版本发布 | 配置项字段和已登记的 intercept。所有插件的 `config` 都保持开放，包括 Graft 自己的插件。                                                | 按版本固定，如 `https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json`。 |

- `graft create` 让 `graft.yml` 指向
  `./graft.schema.json`，并在依赖安装完成后写入该文件。
- 把 `graft.schema.json` 提交到仓库，克隆后编辑器即可检查配置项。
- 直接用包管理器安装或升级包之后，自己运行 `graft schema`。
- 没有登记项的配置保持开放，在启动时由插件自己的 schema 检查。

language server 可能会把 `!env` 标为错误。需要在编辑器设置中声明这个标签，以 VS
Code 为例：

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## 在运行期间修改配置

`graft start` 读取一个版本，不支持
`--watch`。以下编辑和监听规则描述直接嵌入的 Include 与 Loader
API，它们提供协作式生命周期。Include 合并文件和实际目标的通知，等待 100 毫秒后刷新，安装 watcher 后也会补读。

随后 Graft 会比较新的配置项与当前正在运行的配置项：

| 变化                                                     | 结果                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `config` 变化                                            | 通过 [`update`](../fork-handle/) 接收新输入，插件会原地更新或重启。 |
| `name`、`group`、`inject`、`isolate` 或 `intercept` 变化 | 卸载后重新加载。                                                    |
| 新增配置项                                               | 加载。                                                              |
| 移除或禁用配置项                                         | 卸载。                                                              |
| 没有变化的健康配置项                                     | 继续运行，保留现有环境值。                                          |
| 参与调和的分组中的失败项                                 | 重试。尚未完成且未变的解析保留原有激活。                            |

### 并发

- 独立兄弟项的更新与移除并发执行。
- 每个配置项自身的操作仍按顺序执行，替换必须等待该项旧实例清理完毕。
- 分组会等待所有必要操作完成后才接受目标。
- 延迟的环境刷新和普通编辑使用分组的同一个串行协调执行器，不会为了应用更新的目标而中断 update 回调。
- 已移除或过时代次的配置项的请求会被丢弃。

### 清理失败

删除、禁用或替换配置项时若清理失败，Graft 会记录完整 cause 及配置项、fork 标识，并继续协调。

- 被移除的 fork 已处置，替换项拥有独立的生命周期。
- 仍保留的 fork 重启失败时，失败会以 `Failed` 状态保持可见，可以重试。
- resolver 观察资源与生命周期清理的失败会一并记录，不重启健康兄弟项。
- `ready` 将失败 fork 视为已稳定，不保证清理成功。

### 无效文件

初始文件无效时 CLI 启动失败。下表描述嵌入式 Include。

| 情形                    | 行为                                         |
| ----------------------- | -------------------------------------------- |
| 运行期间文件无效        | Graft 记录错误，并继续运行上一次有效的配置。 |
| 文件无效时通过 API 编辑 | 不会将无效文件覆盖为空配置。                 |

嵌入 Include 并提供 `initial`
时，只有 YAML 准备、ID 分配、全树校验及序列化验证全部成功后，才会创建缺失的文件，并一次提交完整文档。无效的初始条目不会留下文件；已有文件优先于
`initial`。

## 符号链接

Include 会保留符号链接。每次磁盘操作先解析配置路径的真实目标，并将该目标与内容快照一起保存。读取、冲突检查、自动补 ID 和 API 编辑都使用同一目标，临时文件也建在目标目录。

| 情形                           | 行为                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| rename 前链接改变              | 丢弃临时文件，沿用有界重试与同字段冲突规则，在新目标上重新应用编辑。                             |
| watch 模式                     | Include 同时监听入口目录和当前目标目录。                                                         |
| 入口链接改变                   | 重新读取，并切换目标监听：关闭旧监听，新监听就绪后再请求一次读取。                               |
| 新目标 YAML 无效               | 保留上一次有效的运行树目标；修正该文件后可恢复。                                                 |
| 未开启 watch                   | 下次 API 编辑会读取新目标。                                                                      |
| 位于监听目录之外的中间链接     | 下次读取时生效，但自身不会触发通知。                                                             |
| 普通文件不存在                 | 可以初始化。                                                                                     |
| 断链、循环链接或不可访问的链接 | 返回类型化文件系统错误，不会被替换成普通文件。请先修复目标；API 编辑或入口变化通知都会重新尝试。 |

:::caution

解析路径与 rename 是两个独立的文件系统操作。链接若在最终核对之后改变，进行中的编辑仍可能提交到旧目标；下次读取则跟随新目标。这与
[Loader API](../loader-api/#并发保存) 中的并发保存窗口相同，不构成跨文件事务。

:::
