<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**园艺学 Effect 系统。** _放心修剪。_

English | 简体中文 | [繁體中文](README.zh-TW.md)

Layer 不由启动时决定。它们是长出来的。

Graft 让 Effect 的 `Layer`
变成动态的。挂载一个 Layer，Graft 会在它需要的一切都可用时构建它，发布它提供的服务，并在某个依赖消失时先把依赖它的部分停掉，再拆除它。配置就是一个普通的发布值，修改它会让依赖它的一切重建。

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, string>()("app/Report") {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => `Report for ${region}`),
)

export const program = Effect.gen(function* () {
	// A value from outside any layer. `set` rebuilds its consumers.
	const region = yield* Graft.publish(Region, "eu")

	// Built while Region is available, torn down and rebuilt when it changes.
	const mount = yield* Graft.mount(report, {
		name: "report",
		requires: [Region],
	})
	yield* mount.await

	yield* region.set("us")
})
```

## 为什么选择 Graft

- **可用性驱动图。**
  挂载等待它需要的服务，全部到齐时构建，其中一个消失时停止。可选依赖出现或消失时，挂载重建。
- **拆除跟随归属。** 每个挂载拥有一个
  `Scope`，它启动的每个 fiber 都有归属。消费者先于提供者停止，然后关闭资源，失败保留完整的
  `Cause`。
- **服务来来去去时也能读取。** `watch`、`await`、`use` 和 `whileAvailable`
  从普通 Effect 代码里读取图，撤回会中断工作，而不是留下过期的值。
- **远程服务仍是服务。** 通过任意 `effect/rpc`
  协议提供一个服务，并在另一个进程或另一台机器上发布它。使用它的挂载无需改动。

Graft 只依赖 `effect`；`@effect/platform-node` 是可选的，只有 `node`
入口需要它。在 Node.js 上运行 Graft 需要 22.19 或更高版本。开发本工作区需要 Node.js
22.22 或更高版本，它同时用于构建文档。

## 开始使用

```sh
npm install effect @graftland/graft
```

阅读[文档](https://docs.graft.land/zh-cn/)。[快速开始](https://docs.graft.land/zh-cn/quickstart/)挂载第一个 Layer；[核心概念](https://docs.graft.land/zh-cn/concepts/)说明图、挂载和发布。

## 一个包

Graft 只发布 `@graftland/graft`。

| 入口            | 内容                             |
| --------------- | -------------------------------- |
| `graft`         | `Graft`、`Mount` 与 `Release`。  |
| `graft/rpc`     | 通过 `effect/rpc` 的远程服务。   |
| `graft/node`    | Node.js 的子进程和 worker 协议。 |
| `graft/testing` | 供测试使用的内存协议。           |

## 旧包

从 0.7.0 起，Graft 是一个动态 Layer 库。之前版本的 API 已移除，且不兼容。

下列软件包已不再开发，不再获得更新：

| 软件包                         | 最后一个版本 | 改用                             |
| ------------------------------ | ------------ | -------------------------------- |
| `@graftland/loader`            | `0.6.0`      | 在自己的程序里用 `Graft.mount`。 |
| `@graftland/hmr`               | `0.5.0`      | 无；Graft 不再重载模块。         |
| `@graftland/cli`               | `0.6.0`      | 无；没有命令，也没有配置文件。   |
| `@graftland/create`            | `0.6.0`      | 无。                             |
| `@graftland/package-manager`   | `0.6.0`      | 无。                             |
| `@graftland/plugin-remote`     | `0.6.0`      | `graft/rpc` 入口。               |
| `@graftland/plugin-http`       | `0.5.0`      | 无。                             |
| `@graftland/plugin-http-api`   | `0.5.0`      | 无。                             |
| `@graftland/plugin-mcp-server` | `0.5.0`      | 无。                             |
| `@graftland/plugin-otlp`       | `0.5.0`      | 无。                             |
| `@graftland/plugin-release`    | 未发布       | 无。                             |

`@graftland/plugin-release`
从未发布，没有对象可标记。在 npm 上标记旧软件包为废弃是可选的独立决定。

## 参与贡献

命令在项目的 [devenv](https://devenv.sh) shell 中运行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

检查项、发布流程和文档站点见[发布](https://docs.graft.land/zh-cn/releases/)。

## 许可证

[Apache 2.0](LICENSE)
