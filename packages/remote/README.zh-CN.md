# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

在子进程、Node
worker 或 runner 上运行 Graft 插件。契约声明跨边界的服务，消费者保留原来的接口。宿主只导入契约，契约的
`module` 指向实现；先把两者构建成 JavaScript。

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

运行 `graft start`，或用 `Graft.plugin(entry)` 加载 TS 插件：

```ts
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { worker: {} },
	config: { greeting: "Hello" },
})
```

TS 和 YAML 共用
`connect`：local、worker、url（ws/wss）、unix、command。认证可以选 mtls、bearer、jwt、none，或第三方
`{ name, config }`
引用。不必另写能力 entry 或服务键字符串。TS 凭证还允许 Effect 或
`{ inject, read }`。自定义宿主需为 Graft 提供 `NodeServices.layer` 和
`SecureRandom.layerWebCrypto`。

runner 配置：

```yaml
- name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth: { mtls: { ca: ./certs/ca.crt } }
```

运行
`graft-remote serve --config runner.yml`。提前安装插件包，保留状态目录，并由外部 supervisor 管理 runner 及后代进程。`graft-remote certificates`
可生成证书。宿主保存的条目 id 默认就是实例名；runner 确认旧进程退出后才接纳替换，并递增 generation。租约和三种停止结果见指南。

worker 不隔离权限；unix 依赖文件权限；stdio 依赖 SSH 等外部机制。token 建议走 wss，被盗后在有效期内可以重放。JWT 只在 upgrade 验证一次。修改契约后须重启宿主，契约导入不参与 HMR。

公开 API：包根 default、`plugin`、`Contract`、`Instance`、公开错误；`/runner`；`/Auth`、`/Transport`、`/Errors`、`/Contract`、`/Testing`；以及
`host/*`、`runner/*`
能力模块。`/internal/bin`、`/internal/worker`、`/internal/watchdog`
只是可执行文件路径，**不是公开 API**。

- [Remote](https://graftland.github.io/graft/zh-cn/remote/overview/)
- [Capabilities](https://graftland.github.io/graft/zh-cn/remote/capabilities/)
- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

本工作区包仍为 private。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
