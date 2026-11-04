---
title: 快速上手
description: 把一个插件先移到子进程，再移到 Node worker，使用它的插件无需改动。
---

本教程把一个插件移出应用进程：先放进子进程，再放进 Node
worker。前提是你已经会写[发布服务](../../services/)的插件。完整代码见示例
[06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote/README.zh-CN.md)。

## 起点

应用里有两个插件：`greeter` 发布 `Greeter` 服务，`welcome` 注入它。

```ts title="src/welcome.ts"
export default Plugin.make({
	name: "welcome",
	inject: [Greeter],
	apply: () =>
		Effect.gen(function* () {
			const greeter = yield* Greeter
			yield* Effect.log(yield* greeter.greet("Alice"))
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

目标是让 `greeter` 在另一个进程中运行，而 `welcome` 一行都不改。

## 1. 拆分契约与实现

宿主不能导入 greeter 的代码，否则这段代码又会在宿主里运行。所以要把插件拆成两部分：

- **契约**：双方需要约定的全部内容，包括插件名、配置 schema、跨越边界的服务，以及实现所在的位置。宿主只导入它。
- **实现**：原来的插件。只有插件进程会导入它。

服务以远程过程调用（RPC）的形式跨越边界。用 `Contract.service`
描述服务，传入服务键、列出所有调用的 Effect `RpcGroup`，以及两个函数：

- `toHandlers` 把真实的服务转换为 RPC 处理函数，运行在服务实现所在的一侧。
- `fromClient` 把 RPC 客户端还原为服务接口，运行在使用服务的一侧。

```ts title="src/contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("@graftland/sample-remote/contract/Greeter") {}

const api = RpcGroup.make(
	Rpc.make("Greet", {
		payload: { name: Schema.String },
		success: Schema.String,
		error: GreetingUnavailable,
	}),
)

const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client
				.Greet({ name })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						GreetingUnavailable.make({ cause }),
					),
				),
	}),
})

export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
```

几点说明：

- `fromClient` 把 `RpcClientError`
  转换成服务自己的错误。连接断开时，调用方看到的就是他们本来就会处理的
  `GreetingUnavailable`。
- `module` 指向与构建后契约放在一起的**构建后**实现。
- `provides` 列出实现向宿主发布的服务。
- 契约以 `contract` 或默认导出的形式导出。

由于双方各自解码契约，契约要遵守几条规则：

- 配置 schema 必须能编码为 JSON，契约中的任何 schema 在编码、解码时都不能依赖服务。
- 同一个契约内服务键必须唯一。不同服务之间的 RPC 方法名可以重复。
- 只有声明过的服务才能跨越边界。双方的服务键和 RPC
  schema 必须一致，所以双方要导入同一个契约。

## 2. 让实现引用契约

实现基本不变，只是改为从契约导入配置 schema 和服务键：

```ts title="src/greeter.ts"
import { Graft, Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

## 3. 构建为 JavaScript

插件进程不使用宿主的 TypeScript 加载器，它导入的是普通 JavaScript，所以要先构建契约和实现。示例使用 tsdown：

```ts title="tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/contract.ts", "src/greeter.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
```

构建产物是 `dist/contract.js` 和 `dist/greeter.js`。两者任一改动后都要重新构建。

## 4. 用 `name: remote` 加载

只替换 `greeter` 条目：

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello

- id: welcome
  name: ./src/welcome.ts
```

| 字段       | 含义                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `contract` | 构建后的契约：相对于本配置文件的路径，或 `my-plugin/contract` 这样的包名。 |
| `connect`  | 插件在哪里运行。`local: {}` 启动子进程。                                   |
| `config`   | 插件自己的配置。启动前会先用契约的 schema 校验。                           |

`name: remote` 会加载 `@graftland/plugin-remote`
包，所以要在应用中安装它。然后启动应用：

```sh
graft start
```

日志中出现 `Hello, Alice!`，这句话现在来自子进程。

## 5. 换成 worker

只修改 `connect`：

```yaml
connect:
  worker: {}
```

问候语现在来自宿主进程内的一个 Node
worker。worker 在自己的线程上隔离执行，但与宿主共用进程和权限。用
`worker: { execArgv: [...] }` 给 worker 传 Node 选项；用
`local: { command: [node, /path/to/bin.js] }` 让子进程使用别的命令启动。

## 变了什么，没变什么

这些保持不变：

- `welcome` 以及其他所有使用 `Greeter` 的插件。
- `Greeter` 接口，以及调用方处理错误的方式。
- 插件的生命周期：停止条目就停止插件进程，重启条目就启动新的插件进程。

这些不一样了：

- **调用要经过连接。** 参数和结果按 RPC
  schema 编码。因连接断开而失败的调用不会重试。
- **修改配置会重启插件。** 改动 `greeting`
  会停止插件进程并启动新进程。远程插件从不[原地更新](../../plugins/#原地更新)。
- **修改契约需要重启。**
  编辑契约后，要重新构建并重启宿主，契约不参与[热重载](../../hot-reload/)。宿主运行期间修改内层
  `config` 或 `connect` 没有问题。
- **错误会被包装。**
  插件的失败按[调用方看到的错误](#调用方看到的错误)所述的方式到达宿主。

## 反方向的服务

`provides` 把服务从插件进程送到宿主；`inject` 方向相反，列出实现需要的宿主服务。

```ts
export const contract = Contract.make({
	name: "report",
	config,
	module: new URL("./report.js", import.meta.url).href,
	inject: [database],
	provides: [reports],
})
```

这里的 `database` 是一个 `Contract.service(Database, ...)` 描述。实现照常注入
`Database`，拿到的是一个调用宿主的客户端。在宿主一侧，远程条目会像其他有依赖的插件一样，等到
`Database` 可用才启动。宿主撤回 `Database` 时，远程插件会停止，直到它重新出现。

## 在 TypeScript 中加载

不写 YAML 条目也可以：用 `Remote.plugin` 在代码中构建插件，再用 `Graft.plugin`
加载。

```ts title="src/entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

- `contractModule` 告诉插件进程从哪里导入契约。它不同于契约自己的
  `module`，后者指向实现。
- `connect` 和 `config` 接受与 YAML 条目相同的数据。
- `shutdownTimeout` 和 `retry`
  只能在这里设置。YAML 条目始终使用默认的五秒停止超时，也没有 `retry`。

`graft` 命令已经提供 Remote 所需的一切。如果你自己构建
`Graft.layer`，请在同一环境中提供 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`；也可以在那里提供 loader 的 `ModuleResolver` 与
`ConfigDirectory`。

## 调用方看到的错误

远程插件的失败以几种形式到达宿主：

| 你看到的                     | 含义                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `error` 中声明的错误         | 插件以契约声明过的错误失败。要声明错误，给契约加上 `error` schema。  |
| `Contract.UndeclaredFailure` | 插件以契约未声明的错误失败，原始值在 `original` 中。                 |
| `RemoteError`                | Remote 自身出错：进程退出、连接断开、runner 拒绝等。请查看 `cause`。 |
| `RemoteWithdrawn`            | 你正在使用的插件服务已被撤回。                                       |

defect 仍然是 defect。[参考](../reference/#错误)列出了所有错误及处理方法。

## 接下来

- 让插件在另一台机器上运行：[在另一台机器上运行插件](../runners/)。
- 了解重启和停止时会发生什么：[重启、替换与停止](../restarts/)。
