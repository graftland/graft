# Graft

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

基于 [Effect](https://effect.website)
的插件框架。Graft 把应用作为一棵插件树来运行。插件发布并使用服务。你可以在进程持续运行的同时加载、重新配置、替换和卸载它们。

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect, Schema } from "effect"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

// Publishes a Greeter while it is loaded.
const greeter = Plugin.make({
	name: "greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`${greeting}, ${name}!`),
		}),
})

// Starts once a Greeter exists, and stops before it goes away.
const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("world")),
})
```

在 Node.js 上运行 Graft 需要 22.19 或更高版本。开发本工作区需要 Node.js
22.22 或更高版本，其中包括用 Astro 构建文档。

## 快速开始

```sh
npx @graftland/cli create my-app --install
cd my-app
npx graft start --watch
```

阅读[文档](https://graftland.github.io/graft/zh-cn/)。了解 cordis？请看[它的概念如何对应到 Graft](https://graftland.github.io/graft/zh-cn/cordis/)。

## 示例

[`samples/`](samples)
以五个简短的编号示例开头。每个示例讲一个概念，从第一个插件到通过 `graft.yml`
运行。

之后是更大的应用，展示 Graft 的用途：

- 由插件构成的聊天机器人
- 在负载下替换定价引擎和数据库的结账服务
- 由 `graft.yml` 驱动的 HTTP 网关
- 多租户服务
- 能在不稳定的上游下继续运行的行情数据管道

## 软件包

| 软件包                                                   | 作用                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [`@graftland/graft`](packages/core)                      | 基于 Effect 的插件框架：插件、fork、服务、隔离、事件和日志。 |
| [`@graftland/loader`](packages/loader)                   | 从条目列表或 YAML 配置文件加载插件。                         |
| [`@graftland/hmr`](packages/hmr)                         | 在 Node.js 上重载插件模块，无需重启进程。                    |
| [`@graftland/cli`](packages/cli)                         | `graft` 命令：`start`、`create`、`add` 和 `remove`。         |
| [`@graftland/create`](packages/create)                   | 生成新的 Graft 项目。`graft create` 使用它。                 |
| [`@graftland/package-manager`](packages/package-manager) | 用 npm、pnpm 或 Yarn 安装依赖，失败时回滚。                  |

所有软件包以相同版本一起发布。它们都需要 `effect` 4.1.x。

## 参与贡献

命令在项目的 [devenv](https://devenv.sh) shell 中运行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

检查项、发布流程和文档站点见[发布](https://graftland.github.io/graft/zh-cn/releases/)。

## 许可证

[Apache 2.0](LICENSE)
