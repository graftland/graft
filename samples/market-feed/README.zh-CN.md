# 行情订阅

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一条能在交易所不稳定时存活的 BTC-USD 监控管道。`exchange` 发布
`Quotes`。`candles` 把它们汇总成一分钟的 K 线并发布 `Candles`。`alerts`
报告收盘价至少比开盘价高 1% 的 K 线。如果已加载 Slack webhook，就通过它发送。

```text
exchange --Quotes--> candles --Candles--> alerts
notifier -------------------Notifier----> alerts (optional)
```

交易所是脚本化的。它的连接在第一根 K 线之后断开，下一次连接尝试被拒绝，再下一次则成功。不需要网络，也不需要凭据。

## 问题

上游连接断开时，它后面的每一个阶段都会受到影响。如果手工实现，你需要：

- 客户端中带退避的重连循环；
- 一种方式，告诉聚合器和告警器它们的输入已经没了；
- 它们各自都要有代码，等待输入恢复并重新订阅；
- 小心处理，确保后台读取器中的失败不会被悄悄丢掉。

添加或移除可选的集成（例如 webhook），也需要它自己的重新配置路径。

## Graft 的做法

业务插件只描述在输入存在时它们做什么：

- **消费者等待它们的提供者。** `candles` 和 `alerts` 在交易所之前加载，保持
  `Pending`，并显示它们缺少的键。发布 `Quotes` 会启动整条链。
- **后台失败受到监督。** 交易所的读取循环通过 `Plugin.fork`
  运行。套接字断开时，Graft 会记录完整的 cause 并撤回 `Quotes`。它先停止
  `alerts`，再停止 `candles`，然后关闭连接，并把 `exchange` 标记为
  `Failed`。消费者回到 `Pending`。
- **重试就是一个调度计划。** `retry: Schedule.exponential("400 millis")`
  在 400 毫秒后（被拒绝）和 800 毫秒后（被接受）各尝试一次新的激活。同样的 fork 再次变为
  `Active`。两个消费者都没有重连循环，也没有对缺失服务的检查。
- **可选依赖只重启它的消费者。** `alerts` 声明了
  `Plugin.optional(Notifier)`。加载或卸载 notifier 只会重启
  `alerts`，在 webhook 发送和仅写日志的发送之间切换。交易所连接和正在进行中的 K 线不会被触碰。
- **状态可观察。** 运行时会在管道于 `Pending`、`Active` 和 `Failed`
  之间变化时，打印 `Graft.forks` 快照。

Graft 恢复的是管道，而不是数据。故障期间发送的行情不会被重放，数据源断开时正在进行的 K 线会被丢弃。回填和可靠投递是另外的问题。

## 运行

在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-market-feed start
```

输出中值得关注的内容：

- 第 1 步：两个消费者都是 `Pending`，各自显示它所等待的服务。
- 第 3 步：`The plugin's background task failed` 以及 `ExchangeUnavailable`
  cause，然后依次是
  `alerts: stopped`、`candles: stopped`、`exchange: stopped`。大约 400 毫秒后出现
  `connecting (attempt 2)`，被拒绝。
- 第 4 步：再过大约 800 毫秒出现
  `connecting (attempt 3)`，三个 fork 都以原来的 ID 变为 `Active`。
- 第 5 步和第 6 步：notifier 出现和消失时，只有 `alerts` 停止并重新启动。

`devenv shell -- pnpm --filter @graftland/sample-market-feed test`
会检查上述每一项说法。它用 `TestClock` 控制重试延迟。

## 文件

| 文件                       | 说明                                          |
| -------------------------- | --------------------------------------------- |
| `src/services.ts`          | 行情和 K 线类型、服务键、传输错误。           |
| `src/exchange.ts`          | 建立连接、运行受监督的读取器、发布 `Quotes`。 |
| `src/candles.ts`           | 一分钟 K 线；发布 `Candles`。                 |
| `src/alerts.ts`            | 1% 规则和可选的 webhook 发送。                |
| `src/notifier.ts`          | 模拟的 Slack webhook。                        |
| `src/scripted-exchange.ts` | 运行和测试所用的脚本化交易所。                |
| `src/observe.ts`           | 等待状态和日志行；fork 树快照。               |
| `src/main.ts`              | 脚本化的运行。                                |
| `test/market-feed.test.ts` | 上述行为的测试。                              |
