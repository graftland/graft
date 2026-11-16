# @graftland/graft

[English](https://github.com/graftland/graft/blob/main/packages/core/README.md)
| 简体中文 |
[繁體中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-TW.md)

在应用运行期间挂载和卸载 Effect 的 Layer。

```sh
npm install effect @graftland/graft
```

`effect` 是 peer 依赖，版本约束为 `4.1.*`。支持的 Node.js 最低版本是 22.19。

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const region = Layer.effect(Region, Effect.succeed("eu"))

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(region, { name: "region" })
	yield* mount.await
})
```

## 它做什么

- `Graft.mount` 在 `requires`
  可用期间构建一个 Layer，发布它的服务，并在某个依赖消失时拆除它。
- `Graft.publish` 把一个值放进图里；`set` 会重建需要它的一切。
- `Graft.watch`、`await`、`use` 和 `whileAvailable` 在服务来来去去时读取它们。
- `Graft.fork` 启动一个归挂载所有的后台 fiber。它的失败带着完整的 `Cause`
  使挂载失败；纯中断不会。
- `Graft.mounts` 和 `Graft.logs` 展示挂载树和收集到的日志。

每个挂载拥有一个
`Scope`，所以拆除时消费者先在提供者之前停止，然后才释放资源。`Mount.CleanupError`
保留每个失败原因。

## 入口

| 入口        | 内容                                   |
| ----------- | -------------------------------------- |
| `.`         | `Graft`、`Mount` 与 `Release`。        |
| `./rpc`     | 通过任意 `effect/rpc` 协议的远程服务。 |
| `./node`    | Node.js 的子进程和 worker 协议。       |
| `./testing` | 供测试使用的内存协议。                 |

## 文档

- [快速开始](https://graftland.github.io/graft/zh-cn/quickstart/)
- [挂载](https://graftland.github.io/graft/zh-cn/mounting/)
- [发布](https://graftland.github.io/graft/zh-cn/publications/)
- [生命周期](https://graftland.github.io/graft/zh-cn/lifecycle/)
- [远程服务](https://graftland.github.io/graft/zh-cn/remote/)

属于 [Graft](https://github.com/graftland/graft)。基于
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 许可。
