# @graftland/plugin-remote

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

让 Graft 插件在子进程、Node
worker 或 runner 上运行。声明跨边界服务后，消费者仍使用原来的服务接口。

契约与实现分开放，宿主只导入契约。先把两者编译成 JavaScript，再加载能力插件和入口：

```ts
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

```yaml
- name: "@graftland/plugin-remote/host/local"
- name: ./entry.ts
```

线程模式用 `Remote.worker()` 和
`host/worker`；worker 与宿主共享进程和权限。连接 runner 用
`Remote.runner({ transport, auth })`：支持 websocket（ws/wss）、unix
socket 和 command/stdio，并按传输选择 mTLS、bearer、JWT 或 none。须显式加载对应的
`host/*`、`host/auth/*` 插件；缺少能力时代理保持 Pending， `Remote.plugin`
不自动安装提供者。

runner 通过 `graft-remote serve --config runner.yml`
或命令行简写启动。提前安装插件包，保留状态目录。部署证书可用
`graft-remote certificates` 签发。通过 `graft.yml`
加载时，保存的条目 id 默认就是实例名。

自行嵌入 Graft 时，为运行时提供 `NodeServices.layer` 和 `effect/crypto` 的
`SecureRandom.layerWebCrypto`。

- [远程插件指南](https://graftland.github.io/graft/zh-cn/remote/)
- [本机子进程与 Node worker 示例](../../samples/remote-worker/README.zh-CN.md)
- [JWT runner 与 SSH 示例](../../samples/remote-runner/README.zh-CN.md)

这个工作区包仍为 private。独立进程不等于权限沙箱。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
