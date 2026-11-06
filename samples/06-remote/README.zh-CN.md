# 06 · 远程插件

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

greeter 仍然是普通插件。这次由你决定它在哪里运行。welcome 依然注入
`Greeter`，调用 `greet("Alice")`。

你会学到：

- 把一个条目换成 `name: remote`，调用方不用改。
- 只改 `connect`，让同一个插件在子进程、Node worker 或 runner 上运行。
- 共享契约，不把实现模块导入宿主。

## 运行

从仓库根目录开始：

```sh
devenv shell -- pnpm build
cd samples/06-remote
devenv shell -- pnpm start
```

看到 `Hello, Alice!` 后，让程序继续运行，边改边看。

## 替换一个条目

普通的服务提供者条目是这样写的：

```yaml
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello
```

本例的 `graft.yml` 只把这个条目换成：

```yaml
- id: greeter
  name: remote
  config:
    contract: "@graftland/sample-remote/contract"
    implementation: "@graftland/sample-remote/greeter"
    connect:
      local: {}
    config:
      greeting: Hello
```

`welcome` 条目和 [`src/welcome.ts`](src/welcome.ts)
都不变。greeter 拆成了两部分：

| 文件                                 | 内容                                                                                                              | 由谁导入       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| [`src/contract.ts`](src/contract.ts) | 插件名、配置 schema，以及 `Greeter` 如何跨越边界。`fromClient` 把 `RpcClientError` 映射为 `GreetingUnavailable`。 | 宿主和插件进程 |
| [`src/greeter.ts`](src/greeter.ts)   | 插件本身，从契约导入 `config` 和 `Greeter`。                                                                      | 只有插件进程   |

插件进程不使用宿主的 TypeScript 加载器，所以
[`tsdown.config.ts`](tsdown.config.ts) 把两者构建到
`dist/`。修改其中任何一个后，用 `devenv shell -- pnpm build`
重新构建。构建还会运行
[`graft schema`](../../packages/docs/content/docs/zh-cn/cli.md#graft-schema)，让编辑器检查两个 YAML 文件中的
`remote` 条目。

1. 把 `greeting: Hello` 改成 `greeting: Hi` 并保存。提供者重启后，welcome 打印
   `Hi, Alice!`。
2. 只把 `connect` 换成：

```yaml
connect:
  worker: {}
```

保存后，问候语就来自 Node
worker 了。worker 与宿主共享进程，隔离执行，**不隔离权限**。local 使用独立进程，也保留当前用户的操作系统权限。`worker: { execArgv: [...] }`
传入 Node 选项，`local: { command: [node, /path/to/bin.js] }` 改用其他命令。

## 换到 runner

另开一个终端，在本目录运行：

```sh
devenv shell -- pnpm runner
# Runs: graft start runner.yml
```

构建时已把本例的包复制到 `.cache/installation`，供 [`runner.yml`](runner.yml)
使用。部署到另一台机器时，在那台机器上安装构建好的插件包及其依赖；宿主不会上传代码。

只改 `graft.yml` 的 `connect` 并保存：

```yaml
connect:
  url: ws://127.0.0.1:7443
  auth:
    none: {}
```

问候语没有变化，这次由 runner 启动子进程。持久化的 `greeter`
条目 id 就是实例名；替换时先确认旧子进程退出，再以更大的 generation 启动新实例。

你会看到 WARN：`ws` 没有加密，`none`
不验证调用方身份。本例只在回环地址上体验流程；部署时请使用 wss 和认证。详见[传输与认证](../../packages/docs/content/docs/zh-cn/remote/transport-auth.md)。

退出时先在宿主终端按 **Ctrl+C**，再停止 runner。运行中可以改业务配置和
`connect`。local/worker 配合 `--watch`
时，重新构建修改后的契约或实现会重启执行单元；使用网络 runner 时，需安装新实现并重启条目。

## 下一步

[聊天机器人](../chat-bot/README.zh-CN.md)把天气集成放进子进程，其他命令留在宿主。
[其他示例](../README.zh-CN.md)展示更多组合方式。
