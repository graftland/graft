# @graftland/plugin-remote

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

把 Graft 插件放到别处运行：子进程、Node
worker，或通过 runner 放到另一台机器上。使用它的插件照常注入它的服务，要改的只有它的配置条目。

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

Remote 隔离的是执行，不是权限。需要权限边界时，请把 runner 放进容器或虚拟机。

## 文档

- [概览](https://graftland.github.io/graft/zh-cn/remote/overview/)：Remote 解决什么问题，各部分如何配合。
- [快速上手](https://graftland.github.io/graft/zh-cn/remote/getting-started/)：把插件移到子进程或 worker。
- [在另一台机器上运行插件](https://graftland.github.io/graft/zh-cn/remote/runners/)：用
  `graft-remote serve` 部署 runner。
- [选择传输与认证](https://graftland.github.io/graft/zh-cn/remote/transport-auth/)
- [重启、替换与停止](https://graftland.github.io/graft/zh-cn/remote/restarts/)
- [编写自己的传输或认证](https://graftland.github.io/graft/zh-cn/remote/capabilities/)
- [参考](https://graftland.github.io/graft/zh-cn/remote/reference/)

## 示例

- [06 · 远程插件](../../samples/06-remote/README.zh-CN.md)
- [聊天机器人](../../samples/chat-bot/README.zh-CN.md)

本工作区包仍为 private。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
