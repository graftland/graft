# HTTP 网关

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

路由、Effect HttpApi 契约和类型化客户端共用一个 HTTP 监听器。`/openapi.json`
发布 API，`/docs` 提供 Scalar。

## 运行

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/http-gateway && pnpm start"
```

```sh
curl 127.0.0.1:3000/health
curl 127.0.0.1:3000/openapi.json
curl 127.0.0.1:3000/docs
curl 127.0.0.1:3000/todos
curl -X POST 127.0.0.1:3000/todos -H 'content-type: application/json' -d '{"title":"Write docs"}'
curl -X DELETE 127.0.0.1:3000/todos/1
```

## 修改

修改源码模块或 `graft.yml` 后，停止进程，重新构建并启动。`start`
读取一个版本，不支持 `--watch`。

## 测试

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

测试直接嵌入协作式插件，在系统分配端口的真实监听器上运行。它们验证路由清理和组合，不证明内核隔离。

## 文件

| File                        | Role                                           |
| --------------------------- | ---------------------------------------------- |
| `graft.yml`                 | Listener, router, mounts and API documentation |
| `src/plugins/health.ts`     | `/health`                                      |
| `src/plugins/events.ts`     | `/events`                                      |
| `src/plugins/todo-store.ts` | In-memory `TodoStore`                          |
| `src/plugins/todos.ts`      | GET, POST and DELETE                           |
| `src/api/Todos.ts`          | HttpApi contract                               |
| `dist/`                     | Built modules selected by configuration        |
