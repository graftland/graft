# @graftland/plugin-remote

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

把 Graft 插件放到别处运行：子进程、Node
worker，或通过 runner 放到另一台机器上。使用它的插件照常注入它的[服务](https://graftland.github.io/graft/zh-cn/services/)，要改的只有它的[配置条目](https://graftland.github.io/graft/zh-cn/config-file/)。

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

- [Remote](https://graftland.github.io/graft/zh-cn/remote/overview/)：Remote 做什么，有哪些局限。
- [宿主条目](https://graftland.github.io/graft/zh-cn/remote/hosts/)：契约、`remote`
  条目、服务与错误。
- [Runner](https://graftland.github.io/graft/zh-cn/remote/runners/)：用
  `graft-remote serve` 在另一台机器上运行插件。
- [传输与认证](https://graftland.github.io/graft/zh-cn/remote/transport-auth/)
- [替换与停止](https://graftland.github.io/graft/zh-cn/remote/lifecycle/)
- [能力插件](https://graftland.github.io/graft/zh-cn/remote/capabilities/)
- [API 参考](https://graftland.github.io/graft/reference/plugin-remote/readme/)

## 示例

- [06 · 远程插件](../../samples/06-remote/README.zh-CN.md)
- [聊天机器人](../../samples/chat-bot/README.zh-CN.md)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
