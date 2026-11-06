# 示例

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

每个示例都是一个可以运行的程序，各自放在独立的包里。

## 从这里开始

刚接触 Graft？请按顺序阅读。每个示例都是一个简短的文件，只讲一个概念，会打印运行过程，并给出可以动手试试的建议。

| 示例                                       | 你将学到                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| [01 · Hello](01-hello)                     | 定义插件、加载插件、修改它的配置、卸载它。                             |
| [02 · Services](02-services)               | 在一个插件中发布服务，在另一个插件中使用它，后者会等待服务出现。       |
| [03 · Events](03-events)                   | 插件卸载时会自动消失的事件处理器。                                     |
| [04 · Failures](04-failures)               | 失败的插件、重试计划，以及属于插件的后台任务。                         |
| [05 · Config file](05-config-file)         | 用 `graft start --watch` 从 `graft.yml` 运行插件，并在运行时编辑它们。 |
| [06 · 远程插件](06-remote/README.zh-CN.md) | 不改调用方，把服务放到子进程、worker 或 runner。                       |

部署和认证方式见
[Remote 文档](../packages/docs/content/docs/zh-cn/remote/overview.md)。

## 真实场景的应用

这些示例把基础概念组合成更大的程序。每个 README 都从一个你原本需要手动解决的问题开始，然后展示 Graft 如何处理它。

| 示例                                       | 场景                                              | 展示内容                                                                                      |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [integration-gateway](integration-gateway) | 独立打包的集成升级时，保持 WebSocket 机器人会话。 | Worker 和子进程升级；安装后的公开包。                                                         |
| [chat-bot](chat-bot)                       | 一个聊天机器人，它的命令和过滤器都是插件。        | 由插件拥有的事件处理器、依赖门控、原地更新、子进程中的天气集成。                              |
| [checkout-upgrade](checkout-upgrade)       | 在定价升级和数据库故障切换期间运行的订单处理器。  | 高负载下的 `Graft.replace` 与重新配置、有序的拆除、排空正在处理的工作。                       |
| [http-gateway](http-gateway)               | 共享待办存储的 HTTP 网关。                        | HttpApi 契约、类型化客户端、实时 OpenAPI 与 Scalar 界面；监听编辑、Pending 路由与实时插件树。 |
| [mcp-tools](mcp-tools)                     | 工具都是插件的 MCP 服务器。                       | `plugin-mcp-server`、客户端连接期间重载工具、坏掉的工具会回滚。                               |
| [saas-tenants](saas-tenants)               | 同一组插件为多个租户提供服务。                    | 每个租户各自的 `isolate` 与 `intercept`、带有租户专属设置的共享服务、租户的接入与退出。       |
| [market-feed](market-feed)                 | 一个建立在不稳定交易所之上的行情数据管道。        | 受监督的后台任务、重试计划、`Pending` 与 `Failed` 状态、可选依赖。                            |

## 运行示例

示例会导入工作区中的包，Node 从这些包的构建产物中加载它们。在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-hello start
```

每个示例的 README 都给出了它的具体命令。`05-config-file`、`06-remote` 和
`http-gateway` 会一直运行，直到你按下
<kbd>Ctrl</kbd>+<kbd>C</kbd>。其他示例打印完过程后就会退出。

`devenv shell -- pnpm test` 会把示例的测试和工作区的其他测试一起运行。
