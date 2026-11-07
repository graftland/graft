---
title: Remote
description: 让单个插件在子进程、Node worker 或另一台机器上运行。
---

Remote 让插件的代码在应用进程之外运行：放进子进程、Node worker，或交给
**runner**——一个在另一台机器上为宿主启动插件的服务。应用（即**宿主**）仍然能看到插件的[服务](../../services/)，注入这些服务的插件不用改。

|            | 直连：`local`、`worker` | Runner                                                |
| ---------- | ----------------------- | ----------------------------------------------------- |
| 在哪里运行 | 宿主上的子进程或 worker | runner 启动的进程，通常在另一台机器上                 |
| 需要安装   | 构建好的插件即可        | 在 runner 上安装插件包并运行 `graft start runner.yml` |
| 连接       | 宿主私有                | `ws`/`wss`、Unix 套接字，或 SSH 之类的命令            |
| 认证       | 无                      | mTLS、bearer token、JWT，或命令自带的认证             |
| 替换插件   | 每次启动都是全新的进程  | 旧进程必须先退出；每次启动对应一个 generation         |

每个加载的 `remote`
条目都有自己的插件进程。停止条目会停止它，重启条目会替换它。挪走插件有以下局限：

- **隔离的是执行，不是权限。**
  子进程以你的用户运行，worker 与宿主共用进程，runner 以它所用账户的权限启动插件。需要权限边界时，请把 runner 放进容器或虚拟机。只想限制同一进程内插件能看到什么，请使用
  [realm](../../isolation/)。
- **配置必须能编码为 JSON。** 插件进程会自行解码它。
- **调用要经过连接。**
  每次调用都是一条消息，因连接断开而失败的调用不会重试。开销见
  [Remote 边界的开销](../../best-practices/production/#remote-边界的开销)。

## 挪走一个插件

在别处运行的插件要拆成两部分。**契约**给出插件名、配置 schema 和跨越边界的服务，双方都导入它。**实现**是插件本身，构建为 JavaScript，只有插件进程导入它。

```ts title="src/contract.ts"
import { Context, Effect, Schema } from "effect"

import { Contract } from "@graftland/plugin-remote"

export class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<string> }
>()("app/Greeter") {}

declare const greeter: Contract.Service

export const config = Schema.Struct({ greeting: Schema.String })

export const contract = Contract.make({
	name: "app/greeter",
	config,
	provides: [greeter],
})
```

```ts title="src/greeter.ts"
import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, contract, Greeter } from "./contract.ts"

export default Plugin.make({
	name: "app/greeter",
	config,
	provides: contract.provides,
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.succeed(`${greeting}, ${name}!`),
		}),
})
```

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    implementation: ./dist/greeter.js
    connect:
      local: {}
    config:
      greeting: Hello
```

`greeter` 描述 `Greeter` 如何跨越边界，见[定义契约](../contracts/)。把
`local: {}` 改成 `worker: {}`
或 runner 的地址，就能再次挪动插件。[06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote)示例把三种方式都走了一遍。
