# HTTP 网关

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由是 `@graftland/plugin-http`
上的挂载。每个路由插件拥有自己的请求与流；插件加载、卸载或热替换时，共享服务器继续监听。

Todos 使用 Effect HttpApi 契约和类型化客户端测试。组合插件在 `/openapi.json`
提供实时文档；同级 Scalar 插件提供 `/docs`。

## 运行

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/http-gateway && pnpm start"
```

服务器绑定 `127.0.0.1:3000`。在另一终端运行：

```sh
curl 127.0.0.1:3000/openapi.json
curl 127.0.0.1:3000/docs
curl 127.0.0.1:3000/health
curl 127.0.0.1:3000/todos
curl -X POST 127.0.0.1:3000/todos -H 'content-type: application/json' -d '{"title": "Write docs"}'
curl -X DELETE 127.0.0.1:3000/todos/1
curl 127.0.0.1:3000/_graft
```

## 编辑

1. 在 `graft.yml` 中为 `todo-store` 设置 `disabled: true`。`/todos`
   返回 404，`/_graft` 显示 `todos` 为 `Pending`。移除设置后路由恢复。
2. 修改 `src/plugins/health.ts` 的响应文本。日志显示
   `Reloaded 1 plugin module(s)`，`/health` 返回新文本；不会出现新的
   `Listening on` 日志。
3. 运行 `curl -N 127.0.0.1:3000/events`，再禁用 `events`。流关闭，`/health`
   仍可用。
4. 把服务器端口改为 3001。日志显示 `Stopped listening on http://127.0.0.1:3000`
   和 `Listening on http://127.0.0.1:3001`；路由插件保留状态。
5. 在 `src/plugins/todos.ts` 中把创建待办的标题改为
   `payload.title + " (edited)"`。日志显示
   `Reloaded 1 plugin module(s)`。POST 新待办的标题包含
   `(edited)`，GET 仍返回已有待办。不会新增 `Listening on` 日志；`/openapi.json`
   与 `/docs` 仍可用。

待办存储位于内存中，插件重启后重置。`DELETE /todos/:id`
删除成功返回 204，id 不存在时返回 404。

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

## 文件

| 文件                                            | 用途                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `graft.yml`                                     | 路由核心、监听器、各路由插件、HttpApi 组合插件及其 Scalar 页面。 |
| `src/plugins/health.ts`                         | 健康检查挂载。                                                   |
| `src/plugins/inspector.ts`                      | 显示实时插件树的挂载。                                           |
| `src/TodoStore.ts`, `src/plugins/todo-store.ts` | 待办路由所需的依赖。                                             |
| `src/api/Todos.ts`                              | 共享 HttpApi 契约和类型化错误。                                  |
| `src/plugins/todos.ts`                          | 同一挂载中的 GET、POST 和 DELETE 路由。                          |
| `src/plugins/events.ts`                         | 卸载时中断的 SSE 挂载。                                          |
| `test/http-gateway.test.ts`                     | 在系统分配的端口上运行真实 HTTP 测试。                           |
