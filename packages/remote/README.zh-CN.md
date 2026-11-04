# @graftland/remote

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

让 Graft 插件在本机 Node.js 子进程或另一台机器上运行。声明跨边界的服务后，宿主插件继续使用原来的服务接口。

```ts
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

把共享的 `Contract.make(...)`
契约与实现模块分开，宿主只导入契约。先将契约和实现编译成 JavaScript，再用
`Graft.plugin` 或 `graft.yml` 加载入口。自行嵌入 Graft 时，为宿主运行环境提供
`NodeServices.layer` 和 `effect/crypto` 的 `SecureRandom.layerWebCrypto`。

连接网络 runner 时使用 `Remote.runner(...)`。在 runner 机器上预装插件包，并用
`graft-remote certificates` 或现有工具准备专用 CA 签发的证书。使用 `graft.yml`
时，默认以保存的条目 id 命名实例。

- [远程插件文档](https://graftland.github.io/graft/zh-cn/remote/)：契约、服务、配置、部署和停止行为。
- [可运行示例](../../samples/remote-worker/README.zh-CN.md)：调用子进程服务，并验证关闭后进程退出。

这个工作区包保持私有。它分开执行进程，不隔离权限；需要权限边界时，请使用虚拟机或容器。

[Graft](https://github.com/graftland/graft) 的一部分，使用
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 许可证。
