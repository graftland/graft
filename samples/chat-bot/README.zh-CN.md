# 聊天机器人

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一个聊天机器人，它的命令、过滤器和集成都是插件。运维人员可以在机器人持续应答的同时，加载、重新配置和卸载这些插件。

## 问题

机器人的功能会越来越多：`/roll`、`/weather`、一个审核过滤器，下个月还会有新的集成。每个功能都要注册处理器、持有连接，并依赖其他部分。如果手工实现，通常需要：

- 一个中央命令注册表，以及在功能关闭时移除其处理器的代码（或者靠重启来关闭功能）；
- 一段 `/help` 文本，必须与当前启用的功能保持同步；
- `if (weatherClient)`
  检查或启动顺序规则，保证命令不会先于它所需的客户端运行，也不会比客户端活得更久；
- 对配置错误的应对方案，因为一个功能的错误可能让整个机器人无法启动。

## Graft 的做法

- **处理器属于注册它的插件。** 命令就是 `apply` 中的
  `Event.on(Command, ...)`。卸载插件时，它的处理器随之移除，没有注册表需要清理。`/help`
  用 `Event.parallel(Describe)` 收集各行内容，所以它列出的正是当前已加载的命令。
- **依赖控制启动与关闭。** `weather` 声明了
  `inject: [Forecasts]`。没有提供者时，它保持
  `Pending`，它的命令也不存在。`forecasts` 加载后，`weather`
  自动启动。`forecasts` 卸载时，`weather` 会在天气客户端断开连接_之前_先停止。
- **配置变更可以原地生效。** `moderation`
  返回一个更新函数，所以新的词表无需重启过滤器即可生效。
- **失败只影响局部。** 无效的配置只会让对应的插件失败，并带有完整的
  `SchemaError`。其他命令继续应答。

## 运行

在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-chat-bot start
```

输出中值得关注的内容：

- 第 2 步：`weather is Pending, waiting for .../Forecasts`，并且 `/weather`
  是未知命令。
- 第 3 步：`forecasts` 一加载，`/weather` 就出现在 `/help` 中。`weather`
  没有被触碰。
- 第 5 步：`Moderation now blocks 2 words`，在它之前没有 `Moderation stopped`。
- 第 7 步：`/weather is gone` 的日志先于
  `Disconnected from the weather service`。

`devenv shell -- pnpm --filter @graftland/sample-chat-bot test`
会检查上述每一项说法。

## 文件

| 文件                        | 说明                                                |
| --------------------------- | --------------------------------------------------- |
| `src/Chat.ts`               | 插件共享的事件、`command()` 和 `receive(message)`。 |
| `src/Forecasts.ts`          | `Forecasts` 服务键。                                |
| `src/plugins/help.ts`       | `/help`，根据当前已加载的命令生成。                 |
| `src/plugins/dice.ts`       | `/roll 2d6`。                                       |
| `src/plugins/forecasts.ts`  | 发布 `Forecasts`。用来代替天气 API 客户端。         |
| `src/plugins/weather.ts`    | `/weather <city>`，需要 `Forecasts`。               |
| `src/plugins/moderation.ts` | 移除含有违禁词的消息的中间件。                      |
| `src/main.ts`               | 脚本化的会话。                                      |
| `test/chat-bot.test.ts`     | 上述行为的测试。                                    |

## 给天气集成一个独立进程

第 3 步用
`Graft.plugin(Remote.plugin(contract, { contractModule, connect: { local: {} } }), config)`
加载普通的 forecasts 插件。天气 SDK 阻塞或退出时，只影响它自己的进程；骰子和审核仍在宿主里运行。天气命令照常注入
`Forecasts`；RPC 失败会转成
`ForecastUnavailable`，命令回复一句暂时不可用。撤回提供者时，只移除依赖它的命令。

[`src/forecastContract.ts`](src/forecastContract.ts)描述这个服务。测试跨进程调用
`/weather`，销毁提供者，再确认 `/roll`
仍能用。这是故障边界，不是权限沙箱。想自己移动一个服务，先看
[06 · 远程插件](../06-remote/README.zh-CN.md)。
