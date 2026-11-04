---
title: 概览
description: Remote 做什么、什么时候该用，以及宿主、runner 和插件进程如何配合。
---

Remote 让插件的代码在应用进程之外运行，应用的其余部分仍然把它当作普通服务来用。本页说明这在什么时候有用、什么时候不合适，以及各部分如何配合。阅读其他 Remote 页面之前，请先看这一页。

## 它解决什么问题

Graft
[插件](../../plugins/)通常都运行在应用进程里。有时你希望某个插件在别处运行：

- **放进单独的进程**：这个插件崩溃、内存泄漏或阻塞事件循环时，不会拖垮整个应用。
- **放进 Node worker**：让它的工作在另一个线程上进行。
- **放到另一台机器上**：靠近它需要的数据、硬件或网络。

有了 Remote，只需修改一个[配置条目](../../config-file/)就能挪走插件。插件照常发布[服务](../../services/)，使用这些服务的插件照常注入。区别只是调用会经过一条连接，送到插件实际运行的地方。

## 什么时候不该用

Remote 隔离的是**执行**，不是**权限**。

- 子进程中的插件以你的操作系统用户运行，权限与应用相同。
- Node worker 与应用共用同一个进程。
- runner 启动的插件，拥有 runner 所用账户的权限。

如果插件不能访问应用能访问的文件、网络或密钥，请把 runner 放进容器或虚拟机，在那里划定边界。如果只是想控制同一进程内插件能看到哪些服务，请使用[realm](../../isolation/)。

挪走插件也有代价：它的配置必须能编码为 JSON，每次调用都变成连接上的一条消息，而因连接断开失败的调用不会自动重试。

## 如何理解它

Remote 各页反复用到下面这些术语：

| 术语         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| **宿主**     | 你的 Graft 应用。它通过名为 `remote` 的条目加载插件。                      |
| **契约**     | 双方都导入的小模块。它给出插件名、配置与共享服务的描述，并指向插件代码。   |
| **实现**     | 插件本身：一个普通的 Graft 插件，构建为 JavaScript。                       |
| **插件进程** | 实现运行的地方：子进程、Node worker，或 runner 启动的进程。                |
| **Runner**   | 一个长期运行的服务，通常在另一台机器上，接受宿主连接并为它们启动插件进程。 |

把插件放到别处有两种方式：

```text
直连：          host ─────────────────────── child process or worker
                                              (implementation)

通过 runner：   host ──────── runner ──────── plugin process
                     wss, unix                (implementation)
                     or ssh
```

**直连**最简单。宿主在本机启动一个子进程（`local`）或 Node
worker（`worker`），不需要额外安装或运行任何东西。

**通过 runner**用于其他机器。你在 runner 所在机器上安装插件包并启动 runner。宿主连接过去，证明自己的身份，再请它启动插件。宿主从不上传代码。

|            | 直连                    | 通过 runner                                         |
| ---------- | ----------------------- | --------------------------------------------------- |
| 插件运行在 | 宿主上的子进程或 worker | runner 启动的进程，通常在另一台机器上               |
| 需要准备   | 构建插件即可            | 在 runner 上安装包并运行 `graft-remote serve`       |
| 连接       | 宿主私有                | WebSocket（`ws`/`wss`）、Unix 套接字或 SSH 等命令   |
| 认证       | 不需要                  | mTLS、bearer token、JWT，或命令自带的认证（如 SSH） |
| 替换插件   | 每次启动都是全新的进程  | 旧进程必须先退出；每次替换都有编号                  |

无论哪种方式，每个加载的 `remote`
条目都有自己的插件进程，并跟随条目的生命周期：停止条目就停止进程，重启条目就替换进程。

## 一个小例子

假设 `greeter` 插件提供 `Greeter` 服务，另一个插件注入 `Greeter` 来打招呼。要让
`greeter` 在子进程中运行，把它的条目换成 `remote` 条目：

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

- `contract` 是构建好的契约模块。
- `connect` 指定插件在哪里运行。`local: {}` 是子进程，`worker: {}` 是 Node
  worker，runner 的地址也写在这里。
- 内层的 `config` 是插件自己的配置。

注入 `Greeter`
的插件不需要任何改动。[快速上手](../getting-started/)会一步步搭出这个例子。

## 示例

- [06 · 远程插件](https://github.com/graftland/graft/tree/main/samples/06-remote/README.zh-CN.md)：在子进程、worker 和 runner 之间移动同一个插件，调用方不变。
- [聊天机器人](https://github.com/graftland/graft/tree/main/samples/chat-bot/README.zh-CN.md)：把天气集成放进子进程运行。

## 接下来

| 页面                                     | 适合在你想……的时候阅读                     |
| ---------------------------------------- | ------------------------------------------ |
| [快速上手](../getting-started/)          | 把第一个插件移到子进程或 worker。          |
| [在另一台机器上运行插件](../runners/)    | 部署 runner，并让宿主连接它。              |
| [选择传输与认证](../transport-auth/)     | 决定宿主与 runner 怎样连接，能防住什么。   |
| [重启、替换与停止](../restarts/)         | 了解重新部署、断网和停止缓慢时会发生什么。 |
| [编写自己的传输或认证](../capabilities/) | 用内置选项之外的方式连接或认证。           |
| [参考](../reference/)                    | 查配置字段、默认值、命令和错误。           |
