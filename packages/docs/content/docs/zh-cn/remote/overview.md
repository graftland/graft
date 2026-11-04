---
title: 概览
description: 把插件放进子进程、Node worker，或交给 runner 运行。
---

把插件放进子进程、Node
worker，或交给 runner 运行。本页帮你选择执行位置；调用方仍然使用普通的 Graft 服务。

## 选择执行方式

- **直连**：`local` 启动子进程，`worker` 在宿主进程中启动 Node
  worker。两者都不需要 runner，每次激活的 generation 都是 1。
- **Runner**：宿主连接到独立运行的 runner，由它启动插件进程。runner 持久化 generation，并在确认旧进程退出后才接纳替换实例。

宿主加载 `name: remote`。runner 在自己的配置中加载 `name: remote/runner`，用
`graft-remote serve --config runner.yml` 启动。

Remote 隔离执行，不隔离权限。需要权限边界时用容器或虚拟机；同一进程中的服务可见性用[隔离](../../isolation/)控制。

## 试一下

[构建好契约和实现](../host/#定义契约)后，加载这个条目：

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

运行 `graft start`。把 `local: {}` 换成 `worker: {}` 就能使用 Node
worker，调用方不用改。

跟着
[06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote/README.zh-CN.md)体验 local、worker 和 runner。[聊天机器人](https://github.com/graftland/graft/tree/main/samples/chat-bot/README.zh-CN.md)则把天气集成放进了子进程。

## 接下来

- [宿主](../host/)：YAML、TypeScript 和共享服务。
- [Runner](../runner/)：安装、配置和 SSH。
- [传输与认证](../transport-auth/)：组合、WARN 和信任边界。
- [替换、租约与停止](../lifecycle/)：generation、期限和失败处理。
- [编写能力插件](../capabilities/)：扩展 remote，并运行共享测试。
