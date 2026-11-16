# 示例

简体中文

每个示例都是自己包里的一个小程序。按顺序阅读；每个示例只讲一个概念，并打印会发生什么。

| 示例                                  | 你会学到                                               |
| ------------------------------------- | ------------------------------------------------------ |
| [01 · 挂载 Layer](01-mount-layer)     | 挂载一个普通 `Layer`，使用它的服务，然后释放它。       |
| [02 · 发布与重建](02-publish-rebuild) | 发布一个值，并在它变化时重建需要它的挂载。             |
| [03 · 失败与重试](03-failure-retry)   | 失败的挂载、重试计划，以及归挂载所有的后台 fiber。     |
| [04 · 租户](04-tenants)               | 用 `isolate` 和 `intercept` 让多个租户共用一套 Layer。 |
| [05 · 远程](05-remote)                | 通过 `effect/rpc` 提供远程服务，并从另一个图连接它。   |
| [06 · 重连](06-reconnect)             | 断开的连接会撤回远程服务；重新连接后它们又会回来。     |

## 运行示例

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/01-mount-layer start
```

每个 README 都给出自己的确切命令。示例 01–04 打印它们的过程后退出。示例 05 和 06 使用
`@graftland/graft/testing` 的内存协议，所以它们也会自己结束。
