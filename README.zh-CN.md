<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**园艺学 Effect 系统。** _放心修剪。_

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/@graftland/graft)](https://www.npmjs.com/package/@graftland/graft)
[![CI](https://github.com/graftland/graft/actions/workflows/ci.yml/badge.svg)](https://github.com/graftland/graft/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/graftland/graft)](LICENSE)

Graft 是面向长期运行的 TypeScript 应用、基于 [Effect](https://effect.website)
的插件运行时。每项能力都是一个依赖显式、生命周期独立的插件，因此你能以可控的影响范围更换其中一项。改动一个插件，`graft start --watch`
只在运行中的进程里替换受影响的插件。

软件不是造出来的，是长出来的。应用是一棵插件树：每个插件嫁接在一个 scope 上，从周围汲取服务，也发布自己的服务。你可以在进程持续运行的同时加载、重新配置、替换和卸载任意一枝。剪掉哪里，树的其余部分都照常生长。

```ts
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

// Publishes a Greeter while it is loaded.
const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`${greeting}, ${name}!`),
		}),
})

// Starts once a Greeter exists, and stops before it goes away.
const hello = Plugin.make({
	name: "app/hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("world")),
})
```

## 为什么选择 Graft

- **热替换。** 不砍树，只换品种。`graft start --watch`
  把每次保存变成一个变更，只重新部署受影响的配置项。变更失败时，内核恢复之前的版本；恢复不了就报告
  `RecoveryFailed`。
- **干净卸载。** 每个插件都在自己的 `Scope`
  中运行，它启动的每个 fiber 都有归属。插件消失时，依赖它的插件先停止，然后执行它的 finalizer。失败（包括清理时的失败）也保留完整的
  `Cause`。
- **在线升级。**
  替换运行在 Worker 或子进程中的插件，使用它的插件继续运行。候选从不可变制品启动，必须通过变更指定的探针；使用
  `Overlap` 时，新调用进入候选，旧调用排空后终止旧单元。升级以
  `Accepted`、`Aborted`、`Recovered`、`RecoveryFailed` 或 `Stuck`
  结束；需要发布记录器记录的升级会等待确认，确认之前显示为记录受阻，见[变更](https://docs.graft.land/zh-cn/transitions/)。
- **依赖受检查。** 服务是 Effect 的 `Context` 键，由 `Layer`
  或其他插件提供。插件在 `inject` 中声明依赖，由编译器检查。

某根枝条需要单独栽种时，[Remote](https://docs.graft.land/zh-cn/remote/overview/)
可以让这个插件在子进程、Node
worker 或另一台机器上运行，使用它服务的插件不必改动。

在 Node.js 上运行 Graft 需要 22.19 或更高版本。开发本工作区需要 Node.js
22.22 或更高版本，其中包括用 Astro 构建文档。

## 快速开始

```sh
npm create @graftland@latest my-app
cd my-app
npm run dev
```

阅读[文档](https://docs.graft.land/zh-cn/)。和编程智能体一起开发？[`graft` skill](skills/graft)
教它用插件化、Effect 化的方式拆解应用，再编写、测试和运行：`npx skills add graftland/graft`。

Graft 的插件模型借鉴自
[cordis](https://github.com/cordiverse/cordis)。cordis 在时空中组合，Graft 只照料自己的园子。请看
[cordis 的概念如何对应到 Graft](https://docs.graft.land/zh-cn/cordis/)。想让编程智能体完成迁移，可以安装[迁移 skills](skills)。

## 示例

[`samples/`](samples)
以六个简短的编号示例开头。每个示例讲一个概念，从第一个插件到通过 `graft.yml`
运行，再到把插件移到另一个进程。

之后是更大的应用，展示 Graft 的用途：

- [WebSocket 集成网关](samples/integration-gateway)，升级插件时保留会话
- 由插件构成的聊天机器人，天气集成在子进程中运行
- 由 `graft.yml` 驱动的 HTTP 网关
- 工具即插件的 MCP 服务器：客户端连着时也能重载工具
- 多租户服务
- 能在不稳定的上游下继续运行的行情数据管道

## 软件包

| 软件包                                                       | 作用                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`@graftland/graft`](packages/core)                          | 基于 Effect 的插件框架：插件、fork、服务、隔离、事件和日志。               |
| [`@graftland/loader`](packages/loader)                       | 从条目列表或 YAML 配置文件加载插件。                                       |
| [`@graftland/cli`](packages/cli)                             | `graft` 命令：`start`、`create`、`add` 和 `remove`。                       |
| [`@graftland/create`](packages/create)                       | 生成新的 Graft 项目：`npm create @graftland` 和 `graft create`。           |
| [`@graftland/package-manager`](packages/package-manager)     | 用 npm、pnpm 或 Yarn 安装依赖，失败时回滚。                                |
| [`@graftland/plugin-remote`](packages/plugin-remote)         | 让插件在子进程、worker 或另一台机器上运行；提供 `graft start runner.yml`。 |
| [`@graftland/plugin-otlp`](packages/plugin-otlp)             | 把一棵插件子树的 span 导出到 OpenTelemetry 收集端。                        |
| [`@graftland/plugin-http`](packages/plugin-http)             | 共享 HTTP 服务器；路由和流随插件的生命周期加载和卸载。                     |
| [`@graftland/plugin-http-api`](packages/plugin-http-api)     | 实时 Effect HttpApi 路由组、类型化客户端和 OpenAPI 文档。                  |
| [`@graftland/plugin-mcp-server`](packages/plugin-mcp-server) | 把插件的工具提供给 MCP 客户端；工具重载时客户端无需重连。                  |

所有软件包以相同版本一起发布。它们都需要 `effect` 4.1.x。

## 方向

在线升级目前支持运行在 Worker、子进程和 runner 中的插件（runner 只能重启，不能重叠）；状态交接与会话续连是下一步。设计是公开的：[价值定义](design/value.md)与[架构](design/architecture.md)。本 README 只描述已经实现的能力。

## 参与贡献

命令在项目的 [devenv](https://devenv.sh) shell 中运行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

检查项、发布流程和文档站点见[发版](https://docs.graft.land/zh-cn/publishing/)。

## 许可证

[Apache 2.0](LICENSE)
