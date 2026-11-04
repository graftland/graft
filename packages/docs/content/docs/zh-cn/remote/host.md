---
title: 宿主
description: 从 YAML 或 TypeScript 加载远程插件时看这一页。
---

从 YAML 或 TypeScript 加载远程插件时看这一页。这里介绍契约、连接配置，以及跨边界使用服务的方式。

## 定义契约

宿主只导入契约。契约的 `module`
指向另一个实现模块，它导出普通 Graft 插件。启动子进程或 worker 前，先把两者构建为 JavaScript；它们不会使用宿主的 TypeScript
loader。

```ts title="contract.ts"
import { Contract } from "@graftland/plugin-remote"
import { Schema } from "effect"

export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
	name: "greeter",
	config,
	module: new URL("./worker.js", import.meta.url).href,
})
```

```ts title="worker.ts"
import { Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { config } from "./contract.js"

export default Plugin.make({
	name: "greeter",
	config,
	apply: ({ greeting }) => Effect.log(greeting),
})
```

契约可以导出为 `contract` 或
`default`。配置必须能编码为 JSON；契约的 codec 不能依赖外部服务。预期内的失败放在契约的
`error` schema 里；不写时默认为 `Schema.Never`。

## 从 YAML 或 TypeScript 加载

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

运行 `graft start`，不需要另写能力 entry 或服务键字符串。要用 Node worker，把
`local: {}` 换成 `worker: {}`。TS 使用同样的 `connect` 数据和业务 `config`：

```ts title="entry.ts"
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { local: {} },
	config: { greeting: "Hello" },
	shutdownTimeout: "5 seconds",
})
```

用 `Graft.plugin(entry)` 加载。`contractModule`
告诉子进程或 runner 去哪里读契约，与契约中指向实现的 `module`
不同。自己嵌入 Graft 时，在构建 `Graft.layer` 的环境中提供 `NodeServices.layer`
和 `SecureRandom.layerWebCrypto`；CLI 已提供。也可以在这个环境里提供 loader 的
`ModuleResolver` 和 `ConfigDirectory`。

连接 runner 时，两边都要安装契约包：

```yaml title="host.yml"
- id: greeter
  name: remote
  config:
    contract: my-plugin/contract
    connect:
      url: !env RUNNER_URL
      ca: ./certs/ca.crt
      auth:
        mtls:
          cert: ./certs/client-billing.crt
          key: ./certs/client-billing.key
      lease: 30 seconds
    config:
      greeting: Hello
```

把 `RUNNER_URL` 设为 `wss://runner.example:7443`，然后运行
`graft start --config host.yml`。相对路径以配置文件所在目录为准，不是 cwd。证书、私钥、CA 的字符串都是文件路径；token 字符串是值本身，读文件要写
`{ file: "./token.txt" }`。同一处只能选择一种传输和一种认证写法。

`connect` 也支持
`unix: /run/graft.sock`、`command: [ssh, runner.example, graft-remote, serve, --config, /srv/stdio.yml]`、`local: { command: [node, /path/to/bin.js] }`
和 `worker: { execArgv: [] }`。command 还可以写 `cwd` 和 `env`。

TS 额外允许用 Effect 读取凭证，每次连接读取一次：

```ts
import { Config } from "effect"

Remote.plugin(contract, {
	contractModule: "my-plugin/contract",
	connect: {
		url: "wss://runner.example:7443",
		instance: "greeter",
		auth: { jwt: { token: Config.Redacted("RUNNER_TOKEN") } },
	},
	config: { greeting: "Hello" },
})
```

凭证来自服务时，可把 Effect 换成
`{ inject: [Vault], read: Vault.pipe(...) }`。token Effect 返回
`Redacted<string>`；mTLS Effect 返回包含 PEM 的
`{ cert: string, key: Redacted<string> }`。Remote 为它创建凭证子插件，显式注入这些依赖；依赖撤回会停止代理。`retry`
写在 `Remote.plugin` 的选项里；RPC 调用不会自动重试。

| `connect` 选项 | 默认值与含义                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`     | loader 条目 id；显式值优先。两者都没有时失败为 `MissingInstance`。                                                                           |
| `lease`        | runner 默认值，通常是 15 秒。宿主可以为这个实例覆盖它。                                                                                      |
| `margin`       | 5 秒；在租约之外多等这么久，获取退出确认。                                                                                                   |
| `expect`       | 默认不检查。`{ version, digest }` 可在激活前强制检查版本、摘要或两者。摘要仅在请求时计算，覆盖包自身除 `node_modules` 外的文件，不覆盖依赖。 |

loader 会把生成的条目 id 写回 YAML，请跨重启保留它。子插件继承
`Entry.CurrentId`：同一条目 fork 出两个 runner 代理时，需要不同的显式 instance，否则它们会互相替换。直接嵌入的
`Group.Group`
只要求兄弟 id 唯一。多个宿主共用认证身份和 instance 名时，也是在操作同一个 runner 实例。

## 自定义能力

自定义能力可以写成 `connect.transport: { name: "my-connector", config: {...} }`
和
`connect.auth: { name: "my-credentials", config: {...} }`。name 按应用的 loader 规则解析，详见[能力插件](../capabilities/)。

## 跨边界使用服务

用 `Contract.service(key, rpcGroup, { toHandlers, fromClient })`
描述服务，再放入 `Contract.make`：

- `inject`：实现需要的宿主服务。
- `provides`：实现发布给宿主消费者的服务。

只有声明过的服务会跨边界。服务键和 RPC
schema 必须一致；一个契约内服务键不能重复，不同服务的 RPC 方法名可以重复。[示例契约](https://github.com/graftland/graft/blob/main/samples/06-remote/src/contract.ts)展示了如何在
`fromClient` 中把 `RpcClientError` 映射成服务自己的错误。

正常撤回时，先结束消费者；连接健康时，它们的 finalizer 仍可调用远程服务。宿主依赖撤回会停止代理，依赖回来后再恢复。子插件撤回导出的服务，也会停止宿主消费者。连接故障可能中断调用和 finalizer。

## 热重载

宿主 entry 重载会替换执行单元；runner 确认旧实例退出后才增加 generation。**修改契约后需要重启宿主**，原始契约导入不参与 HMR。runner 的实现模块不在宿主 HMR 图中；在 runner 上部署，再重启代理。

关闭期限和失败上报见[替换、租约与停止](../lifecycle/)。
