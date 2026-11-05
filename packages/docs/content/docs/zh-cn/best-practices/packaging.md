---
title: 插件包
description: 把插件发布为 npm 包，让应用按名称加载、在其上构建，并能安全升级。
---

**插件包**是模块导出插件的 npm 包。应用安装它之后，可以在 `graft.yml`
中按名称加载，也可以在代码中导入，并针对它声明的服务和事件编写自己的插件。先用
`plugin`
模板创建包，并遵循[发布插件](../../plugins/#发布插件)中的三条规则；本页讲其余事项。

## 规划包的结构

把消费方用来构建的令牌和实际运行的插件分开存放。
[在共享模块中声明令牌](../design/#在共享模块中声明令牌)说明了令牌模块里放什么。

```ts title="src/tokens.ts"
import { Context, Effect, Schema } from "effect"

export class Database extends Context.Service<
	Database,
	{ readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>> }
>()("graft-plugin-postgres/Database") {}

export const Config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
	poolSize: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
})
```

```ts title="src/index.ts"
import { Effect, Redacted } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Config, Database } from "./tokens.js"

declare const openPool: (
	url: Redacted.Redacted<string>,
	size: number,
) => Effect.Effect<{
	readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>>
	readonly close: Effect.Effect<void>
}>

export default Plugin.make({
	name: "postgres",
	config: Config,
	apply: ({ url, poolSize }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				openPool(url, poolSize),
				(pool) => pool.close,
			)
			yield* Graft.provide(Database, { query: pool.query })
		}),
})
```

每一部分都作为单独的入口导出：

| 导出         | 内容                                                 | 导入方                                                                            |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `.`          | 插件本身，作为默认导出或名为 `plugin` 的导出。       | 加载器，对应 `graft.yml` 中的 `name:`。                                           |
| `./tokens`   | 服务键、事件、Reference、带标签的错误和配置 schema。 | 消费方插件、测试，以及实现同一服务的其他包。                                      |
| `./<plugin>` | 另一个插件，每个模块一个。                           | `name: postgres/migrations` 这样的条目。                                          |
| `./contract` | [Remote 契约](../../remote/hosts/#定义契约)。        | 插件能在别处运行时，供宿主和 [runner](../../remote/runners/#部署-runner) 导入。   |
| `./schema`   | 配置的[编辑器登记项](#编辑器补全)。                  | 应用的编辑器 schema。                                                             |
| `./cli`      | 添加 `graft` 子命令的命令插件。                      | [`graft add --plugin <package>`](../../cli/#命令插件)，它会启用 `<package>/cli`。 |

| 规则                             | 避免的问题                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `./tokens` 不导入任何实现。      | 否则只注入 `Database` 的插件、或伪造它的测试，也会加载你的驱动及其依赖。                                   |
| 每个模块一个插件。               | 加载器从一个模块中只取一个插件：默认导出，没有时取 `plugin`。模块导出的其他插件无法在 `graft.yml` 中引用。 |
| 契约通过 `module` URL 指明实现。 | 如果契约导入实现，实现也会在宿主上加载，而不只是在插件进程中。                                             |

## 声明依赖

```json title="package.json"
{
	"name": "graft-plugin-postgres",
	"version": "1.0.0",
	"type": "module",
	"sideEffects": false,
	"engines": { "node": ">=22.19.0" },
	"exports": {
		".": "./dist/index.js",
		"./tokens": "./dist/tokens.js",
		"./schema": "./dist/schema.js"
	},
	"peerDependencies": {
		"@graftland/graft": "^0.4.0",
		"effect": "4.1.*"
	},
	"devDependencies": {
		"@graftland/graft": "0.4.1",
		"effect": "4.1.2"
	},
	"dependencies": {
		"postgres": "^3.4.0"
	}
}
```

| 包                                                                | 放在                                    | 原因                                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`、`@graftland/graft`                                      | `peerDependencies` 和 `devDependencies` | 应用中[每个包只能有一份](../../hot-reload/#插件模块的规则)。放在 `dependencies` 中时，如果应用已有的版本不满足你的范围，就会再装一份。 |
| `@graftland/loader`、`@graftland/cli`、`@graftland/plugin-remote` | 同上，仅当你的模块导入它们时            | 它们与 `@graftland/graft` 一起发布并锁定其版本，因此使用相同的范围。                                                                   |
| 其他所有包，例如驱动和客户端                                      | `dependencies`                          | 它们是你的包私有的。                                                                                                                   |

## 编写可加载、可重载的模块

条目加载插件时，应用会导入你的插件模块；在 `graft start --watch`
下热重载时，还会再次导入。包中的每个文件都要遵守[插件模块的规则](../../hot-reload/#插件模块的规则)，并且[在 `apply` 中获取资源，而不是在导入时](../effect/#导入时只描述在-apply-中获取)。插件包最常违反的是以下几条：

| 规则                                                                   | 避免的问题                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发布 ESM，并让插件模块导入的内容中不含 CommonJS 和原生插件依赖。       | 入口能到达的 CommonJS 或原生依赖会让热重载报告 `Skipped` / `restart-required`（见[重载未生效的情形](../../hot-reload/#重载未生效的情形)）。对这类依赖，接受重启，或在 [Remote](../../remote/overview/) 下运行插件。 |
| 插件模块中不要导入 `node:module` 和 `module`，`createRequire` 也不行。 | 这样的导入会让整张依赖图[退出热重载](../../hot-reload/#重载未生效的情形)，直到进程重启。                                                                                                                            |
| 从 `config` 读取设置，而不是从 `process.env`。                         | 用户在 `graft.yml` 中既看不到也设置不了这些值。[`--env-file` 中的值](../../cli/#环境变量文件)不会进入 `process.env`，`loader.retry` 也不会重新读取你的变量。                                                        |

## 把配置和键当作公开 API

用户会在 `graft.yml` 中写你的配置字段，也会在
[`inject` 和 `isolate`](../../config-file/#规则)
中写你的键字符串，所以改动其中任何一个都会破坏他们的文件。

| 写法                                             | 目的                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| 用 `Schema.withDecodingDefaultKey` 设置默认值    | 条目可以省略该字段。                                                        |
| 密钥用 `Schema.RedactedFromValue(Schema.String)` | 日志会隐藏它的值，用户可以用 [`!env`](../../config-file/#类型与密钥) 传入。 |
| 值可能来自 `!env` 时，schema 从字符串解码        | `!env` 得到的是字符串；例如 `Schema.NumberFromString` 会把它转成数字。      |
| 配置能编码为 JSON                                | 插件可以在 [Remote](../../remote/overview/) 下运行。                        |

各种改动对已有条目的影响：

| 改动                            | 已有条目                                                            |
| ------------------------------- | ------------------------------------------------------------------- |
| 新增带默认值的字段              | 照常工作。                                                          |
| 新增必填字段，或收紧校验        | 以 `SchemaError` 失败，并保持 `Failed`，直到它们的配置被修改。      |
| 删除字段                        | 照常工作。解码会直接丢弃未知字段，不报错。                          |
| 重命名字段                      | 旧值被静默丢弃。如果新字段有默认值，不会有任何失败。                |
| 修改服务、事件或 Reference 的键 | 消费方和 `graft.yml` 中的键不再匹配。必需的消费方停留在 `Pending`。 |

新增必填字段、收紧校验、重命名字段或修改键，都要作为新的主版本发布，并在更新日志中写明用户需要修改什么。

## 选择包名

`graft.yml` 中的短名称会查找名为 `graft-plugin-<name>` 的无作用域包：

| 包                            | 用户写法                                          |
| ----------------------------- | ------------------------------------------------- |
| `graft-plugin-postgres`       | `name: postgres` 或 `name: graft-plugin-postgres` |
| 该包的 `./migrations` 导出    | `name: postgres/migrations`                       |
| `@acme/graft-plugin-postgres` | `name: "@acme/graft-plugin-postgres"`，写全名     |

- 应用从自己的目录解析[插件名称](../../config-file/#插件名称)，因此应用必须依赖你的包，例如通过
  `graft add` 添加。
- 短名称先按原样尝试，只有某个候选不存在时，Graft 才会尝试下一个。如果应用能解析到名为
  `postgres` 的包（比如你的驱动），`name: postgres` 和
  `name: postgres/migrations` 都会以 `ModuleInvalid` 失败。
- README 中的 `graft.yml` 示例请写完整包名，它不会解析到别的包。
- `graft add --plugin` 会保留以 `@` 或 `graft-plugin-`
  开头的名称，其他名称则变成 `@graftland/plugin-<name>`。带 `./cli`
  导出的包需要使用这两种形式之一。

## 编辑器补全

`graft.yml`
的编辑器 schema 不检查插件配置。导出一个登记项，应用就能检查你的条目：

```ts title="src/schema.ts"
import { JsonSchema, Schema } from "effect"

import { Config } from "./tokens.js"

export const entries = () => [
	{
		names: ["postgres", "graft-plugin-postgres"],
		schema: JsonSchema.toDocumentDraft07(
			Schema.toJsonSchemaDocument(Config, {
				referencePolicy: () => undefined,
				onExcessProperty: "error",
			}),
		).schema,
		required: true,
	},
]
```

| 字段       | 规则                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names`    | 用户可能为该插件写的每一个 `name`，包括短名称和全名。                                                                                                               |
| `schema`   | 配置 schema 的编码侧。`referencePolicy: () => undefined` 会把定义内联，否则这些定义会丢失。`onExcessProperty: "error"` 会标出未知字段，否则解码时它们会被悄悄丢弃。 |
| `required` | 配置有必填字段时设为 `true`，这样没有 `config` 的条目会被标出。                                                                                                     |

这里只导入令牌模块：生成 schema 不能加载插件。应用把登记项传给
`ConfigSchema.make`，见[编辑器支持](../../config-file/#编辑器支持)。

## 支持的 Graft 版本

| 范围                | 规则                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@graftland/*` peer | Graft 处于 0.x 阶段时，[任何版本都可能改变 API](../../releases/#发布版本)。`^0.4.0` 只接受 0.4.x；测试过下一个次版本后再放宽。                 |
| `effect` peer       | 使用你所支持的 `@graftland/graft` 版本声明的范围，例如 `4.1.*`。                                                                               |
| `devDependencies`   | 在 peer 范围内写确切版本，这样测试运行在你声称支持的某个版本上。                                                                               |
| 你自己的版本        | 如上所述，破坏性的配置或键改动要发布新的主版本。宿主可以用 [`connect.expect`](../../remote/runners/#实例) 要求 runner 上的插件为你的某个版本。 |

## 在应用中试用

自动化测试见[测试](../testing/)。要像用户那样试用你的包：

1. **打包**：运行 `npm pack`。
2. **创建**应用：运行
   [`graft create playground`](../../cli/#graft-create)。它已经依赖
   `@graftland/graft`、`@graftland/cli` 和 `effect`，满足你的 peer 依赖。
3. **安装**打包出的 tarball，使用应用的包管理器。
4. **添加**条目，使用 README 中的名称，然后运行 `graft start`。

:::caution

安装 tarball，不要链接目录。链接的包会从它自己的 `node_modules` 解析 `effect` 和
`@graftland/graft`，而你的 `devDependencies`
就装在那里，于是应用里每个包都会多出一份。

:::
