# 06 · 重连

简体中文

连接可能断开。Graft 把存在流当作真相来源，所以丢失的连接会撤回每个远程服务，重新连接则把它们带回来。

你会学到：

- 连接正常期间，connect 挂载会把服务器上可用的服务镜像到本地图里。
- 连接结束时，远程服务会被撤回。`Graft.watch`
  先发出当前可用性，再发出每次变化，所以它能显示每次撤回和每次发布。
- 有了
  `retry`，connect 挂载会打开新的协议并再次连接。服务器再次报告该服务时，它会被再次发布。
- 下游挂载遵循同样的生命周期：服务被撤回时它们停止，服务回来时它们再次启动。

示例使用 `@graftland/graft/testing`
的内存协议，它可以按需结束当前连接。真实应用依赖 socket、HTTP 响应或 worker 消失时传输层随之结束。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/06-reconnect start
```

```text
The remote service is gone
The remote service is available
Before the drop, the book costs 12
The remote service is gone
The connection dropped and the remote service was withdrawn
The remote service is available
The connection is back and the remote service is published
After reconnecting, the book costs 12
```

第一行是观察者的初始值：服务还没有被发布。图还会在重新连接前记录失败的连接尝试。日志器会加上时间戳和挂载标注；这里省略了它们。

## 试一试

- 删掉 `retry`。断线后挂载会保持 `Failed`，远程服务永远不会回来。
- 在另一个挂载里使用
  `Graft.whileAvailable(Pricing, ...)`。它会在断线时停止工作，并在重连后恢复，不需要任何自己的重连代码。
