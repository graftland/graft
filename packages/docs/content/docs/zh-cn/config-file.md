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

## 配置项字段

| 字段        | 作用                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `id`        | 标识配置项。如果未指定，Graft 会生成一个并写回文件。                            |
| `name`      | 插件模块，可以是相对路径、包名或短名称。分组会忽略此字段。                      |
| `config`    | 插件的输入；对于分组，则是其配置项列表。                                        |
| `disabled`  | 设为 `true` 时卸载该项，但保留在文件中。                                        |
| `group`     | 设为 `true` 时，该项成为包含其他配置项的分组。                                  |
| `inject`    | 加载插件前需要等待的服务键，作为插件自身 `inject` 声明的补充。                  |
| `isolate`   | 需要[隔离](../isolation/)的键。`true` 表示私有领域（realm），标签表示共享领域。 |
| `intercept` | 按 Reference 键设置的值，对该项及其所有后代生效。                               |

服务键和 Reference 键是创建它们时使用的字符串。例如，`Context.Service<...>()("app/Database")`
对应的服务键是 `app/Database`。

`intercept`
的值会替换外层的值。如果两者都是对象，则合并字段，同名字段以当前项为准。

## 插件名称

以 `.` 开头的 `name` 是相对于配置文件的路径，以 `/` 开头的是绝对路径。以 `@`
开头或包含 `:`
的名称直接使用。其他名称会依次尝试原名称、`@graftland/plugin-<name>` 和
`graft-plugin-<name>`。包从应用目录解析。

如果找不到插件或模块导入失败，该配置项仍会出现在 fork 树中，显示为带错误的失败 fork。当配置项变化，或[热重载](../hot-reload/)检测到新代码时，会再次尝试加载。

## 环境变量

`!env NAME`
在加载配置项时读取环境变量。文件中保留原始标签，因此密钥不会被写入文件。如果变量未设置，该项会失败，直到问题修复。

## 在运行期间修改配置

使用 `graft start --watch`
时，Graft 会监听配置文件。保存后，Graft 会比较新的配置项与当前正在运行的配置项：

- `config` 变化的配置项通过
  [`update`](../lifecycle/#fork-句柄)接收新输入，插件会原地更新或重启。
- `name`、`group`、`inject`、`isolate` 或 `intercept`
  变化的配置项会被卸载，再重新加载。
- 新增的配置项会被加载，移除或禁用的配置项会被卸载。
- 没有变化的配置项继续运行。

如果文件内容无效，Graft 会记录错误，并继续运行上一次有效的配置。

## 通过代码编辑配置项

加载器发布了 `Loader` 服务，插件可以注入它来读取和编辑配置项：

```ts
import { Loader } from "@graftland/loader"

const admin = Plugin.make({
	name: "admin",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			const id = yield* loader.create({ name: "./plugins/cron.mjs" })
			yield* loader.update(id, { config: { every: "5 minutes" } })
			yield* loader.update("api", { disabled: true })
		}),
})
```

| 成员                      | 作用                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `entries`                 | 当前配置项。                                                                    |
| `changes`                 | 先发出当前配置项，再发出每次变化的流。                                          |
| `create(entry, options?)` | 将配置项添加到根列表末尾，或添加到 `parent` 分组的 `position` 位置，返回其 id。 |
| `update(id, patch)`       | 修改配置项的部分字段。                                                          |
| `remove(id)`              | 移除配置项。                                                                    |
| `ready`                   | 等待树中所有 fork 离开加载状态。                                                |
| `retry`                   | 重新加载所有插件或配置解析失败的配置项。                                        |

编辑结果会写回文件。Graft 会保留文件中的注释、格式和 `!env`
标签，并先写入临时文件，避免配置文件只写了一半。

如果文件在 Graft 上次读取后被其他人修改，Graft 会先重新读取文件，再应用编辑。如果编辑涉及的字段也在文件中被修改，则以文件为准：Graft 会放弃这次编辑并记录警告。

`ready`
不会等待相互依赖的插件全部稳定下来：服务提供方启动后，依赖它的插件仍可能短暂处于
`Pending` 状态。
