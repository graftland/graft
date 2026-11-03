# HTTP 网关

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一个真实的 HTTP 服务器，它的路由来自 `graft.yml`
中列出的插件。编辑该文件就能添加、移除和重新配置路由，保存代码就能修改路由的代码。进程全程保持运行。

## 问题

长期运行的 HTTP 服务通常在启动时一次性设置好路由。想改变它提供的内容，有两种选择。一种是重启，这会丢掉连接和内存中的状态。另一种是手写一个管理层来修改路由器，而这个管理层还必须记得关闭每个功能打开的所有资源。依赖某个存储的功能需要启动顺序，关闭这个存储则需要为使用它的路由制定处理方案。

## Graft 的做法

- **服务器对路由一无所知。** `server` 负责监听，并用 `Event.bail` 把每个请求交给
  `Route` 事件。路由就是插件内部的一个 `Event.on`
  处理器，所以只要该插件还在加载，路由就存在。
- **配置文件是唯一的事实来源。** `graft start --watch`
  在每次保存时，让运行中的树与 `graft.yml`
  保持一致。只有发生变化的条目会被触碰。如果禁用
  `todo-store`，服务器仍会继续监听。如果修改服务器的
  `port`，服务器会重启，而不会触碰任何路由。
- **依赖是显式的。** `todos` 注入 `TodoStore`。存储被禁用时，`todos` 处于
  `Pending`，它的路由返回 404。重新启用存储，路由就会回来。`todos`
  中没有任何代码检查存储是否存在。
- **代码原地重载。**
  保存插件模块时，Graft 会导入新版本，并用它替换正在运行的插件。进程不会重启。正如[热重载文档](../../packages/docs/content/docs/zh-cn/hot-reload.md)所说明的，一次代码变更会重启从该模块加载的每个插件，包括服务器。
- **你能看到这棵树。** `GET /_graft` 会打印实时的 fork 树和每个插件的状态，包括
  `Pending` 插件正在等待什么。

## 运行

在仓库根目录执行：

```sh
devenv shell -- pnpm build
cd samples/http-gateway
devenv shell -- pnpm start
```

服务器监听 3000 端口。在另一个终端中：

```sh
curl localhost:3000/health
```

```sh
curl localhost:3000/todos
```

```sh
curl -X POST localhost:3000/todos -d '{"title": "Write docs"}'
```

```sh
curl localhost:3000/_graft
```

然后，在它运行的同时：

1. 在 `todo-store` 条目中添加 `disabled: true` 并保存。日志只显示
   `Todo store closed`，没有其他内容。`/todos` 返回 404，`/_graft` 把 `todos`
   显示为 `Pending (waiting for .../TodoStore)`。再把这一行删掉，`/todos`
   就恢复了。
2. 把服务器的 `port` 改为 `3001` 并保存。日志显示
   `Stopped listening on http://localhost:3000` 和
   `Listening on http://localhost:3001`。存储保留着它的 todo。
3. 修改 `src/plugins/health.ts` 中的文本并保存。日志显示
   `Reloaded 5 plugin module(s)`，`/health` 返回新的文本。

todo 存储在内存中，所以每次重启它时，其中的 todo 都会被重置。

`devenv shell -- pnpm --filter @graftland/sample-http-gateway test`
会在空闲端口上启动服务器，并通过 HTTP 检查路由和配置的行为。

## 文件

| 文件                        | 说明                                          |
| --------------------------- | --------------------------------------------- |
| `graft.yml`                 | `graft start` 加载的条目。                    |
| `src/Gateway.ts`            | `Route` 事件、`route()` 和 `Gateway` 地址键。 |
| `src/TodoStore.ts`          | `TodoStore` 服务键。                          |
| `src/plugins/server.ts`     | HTTP 服务器。                                 |
| `src/plugins/health.ts`     | `GET /health`。                               |
| `src/plugins/inspector.ts`  | `GET /_graft`，实时的 fork 树。               |
| `src/plugins/todo-store.ts` | 内存中的 `TodoStore`。                        |
| `src/plugins/todos.ts`      | `GET /todos` 和 `POST /todos`。               |
| `test/http-gateway.test.ts` | 通过真实 HTTP 进行的测试。                    |
