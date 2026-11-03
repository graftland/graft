# 结账升级

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

在升级定价引擎、数据库故障转移到新主机的同时，一个订单 worker 持续消费队列。没有订单丢失，没有订单被处理两次，也没有任何查询会落到已关闭的连接池上。

## 问题

在运行中的服务里替换依赖，正是关闭类 bug 的高发地。要在不重启的情况下替换定价引擎或迁移到新的数据库主机，通常需要：

- 停止接收新任务，但完成已在进行中的订单；
- 按正确的顺序，先停止所有使用旧引擎或旧连接池的部分，再关闭它；
- 启动新的引擎或连接池，再让使用者基于它重新启动；
- 在整个过程中保持队列和已存储的数据完好。

大多数服务选择放弃，直接重启进程，导致进行中的任务丢失。或者为每个依赖手写一套定制的排空并替换流程。

## Graft 的做法

插件的写法就好像一切都不会改变。`checkout` 在 `apply` 中只读取一次 `Database` 和
`Pricing`。`order-worker` 只读取一次 `Checkout`。变更由 Graft 处理：

- **`Graft.replace([[pricingV1, pricingV2]])`**
  用新引擎重启旧引擎的每一个 fork。在 `Pricing v1 unloaded`
  之前，Graft 先停止 worker，再停止
  `checkout`，因为它们使用 v1 发布的内容。然后按依赖顺序启动 v2、`checkout`
  和 worker。TypeScript 会检查 v2 接受与 v1 相同的输入。
- 对数据库调用
  **`fork.update({ url })`**，会用新主机重启它，顺序相同。worker 先完成已取走的订单，`checkout`
  停止，然后旧连接池关闭，新连接池打开。
- **停止时会等待进行中的任务。**
  worker 以不可中断的方式处理每个订单。Graft 会停止 `Plugin.fork`
  任务并等待它们结束，然后才撤回它们所用的任何服务。
- **比插件存活更久的东西放在环境中。** 订单队列和数据库的存储被提供给
  `Graft.layer`，所以它们能撑过每一次重启。替换期间到达的订单会在队列中等待。

数据库插件会把对已关闭连接池的查询变成 defect。因此，如果顺序出过错，worker 会失败，运行输出中会显示错误。

## 运行

在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade start
```

输出中值得关注的内容：

- 第 2 步：`Order worker stopped`、`Checkout down`、`Pricing v1 unloaded`，然后这三者以 v2 重新启动。此后的订单由 v2 定价：三件商品的购物车从 $52 降到 $46.8。
- 第 3 步：进行中的订单在 `db-1` 上完成，_先于_ `Order worker stopped` 和
  `Closed pool to postgres://db-1...`。
- 第 4 步：`24 orders placed, 24 receipts, 24 distinct orders`。

`devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade test`
会检查上述每一项说法。

## 文件

| 文件                            | 说明                                         |
| ------------------------------- | -------------------------------------------- |
| `src/Orders.ts`                 | 订单队列和数据库存储，二者都在环境中。       |
| `src/Checkout.ts`               | `Database`、`Pricing` 和 `Checkout` 服务键。 |
| `src/plugins/database.ts`       | 打开连接池并发布 `Database`。                |
| `src/plugins/pricing.ts`        | 定价引擎 v1 和 v2。                          |
| `src/plugins/checkout.ts`       | 为订单报价并存储；发布 `Checkout`。          |
| `src/plugins/worker.ts`         | 从队列中逐个取出订单。                       |
| `src/main.ts`                   | 脚本化的运行。                               |
| `test/checkout-upgrade.test.ts` | 上述行为的测试。                             |
