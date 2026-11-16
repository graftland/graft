# 05 · 远程

简体中文

服务可以活在另一个图或另一个进程里，而调用方无需知道。传输层就是一个
`effect/rpc` Protocol。

你会学到：

- `Remote.service` 声明一个契约：本地服务键、一个
  `RpcGroup`，以及它们之间的两种映射。
- `Remote.serve`
  暴露每个服务当前可用的契约。它返回一个 Mount，所以归当前作用域所有。
- 连接期间，远程服务会在本地发布。`Graft.use`
  等待它，在调用期间持有它，随后释放它。
- 可用性会经由连接传递，所以服务器上消失的服务在客户端也会消失。

示例使用 `@graftland/graft/testing`
的内存协议。真实应用则传入 socket、HTTP 或 worker 协议。

示例逻辑在 [`src/program.ts`](src/program.ts) 里，[`src/main.ts`](src/main.ts)
运行它。

## 运行它

在仓库根目录：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/05-remote start
```

```text
The book costs 12
```

## 试一试

- 删掉服务器上的 `pricing` 挂载。客户端会停在 `Graft.use`
  里等待，而不是收到价格。
- 给 `PricingRpcs` 加第二个 RPC，并给 `Pricing`
  加第二个方法。契约双向携带，所以远程服务也会有它。
