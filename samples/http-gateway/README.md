# HTTP gateway

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Routes are mounts on `@graftland/plugin-http`. Each route plugin owns its
requests and streams; the shared server keeps listening while plugins load,
unload, or hot-swap.

Todos use an Effect HttpApi contract and a typed client test. The composer
serves live `/openapi.json`; a sibling Scalar plugin serves `/docs`.

## Run it

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/http-gateway && pnpm start"
```

The server binds `127.0.0.1:3000`. In another terminal:

```sh
curl 127.0.0.1:3000/openapi.json
curl 127.0.0.1:3000/docs
curl 127.0.0.1:3000/health
curl 127.0.0.1:3000/todos
curl -X POST 127.0.0.1:3000/todos -H 'content-type: application/json' -d '{"title": "Write docs"}'
curl -X DELETE 127.0.0.1:3000/todos/1
curl 127.0.0.1:3000/_graft
```

## Edit it

1. Set `disabled: true` on `todo-store` in `graft.yml`. `/todos` returns 404 and
   `/_graft` shows `todos` as `Pending`. Remove the setting to restore the
   routes.
2. Change the response text in `src/plugins/health.ts`. The log shows
   `Reloaded 1 plugin module(s)` and `/health` returns the new text. There is no
   new `Listening on` line.
3. Run `curl -N 127.0.0.1:3000/events`, then disable `events`. The stream closes
   while `/health` still works.
4. Change the server port to 3001. The log shows
   `Stopped listening on http://127.0.0.1:3000` and
   `Listening on http://127.0.0.1:3001`; route plugins keep their state.
5. In `src/plugins/todos.ts`, change the created todo title to
   `payload.title + " (edited)"`. The log shows `Reloaded 1 plugin module(s)`.
   POST a todo: its title includes `(edited)`, and GET still lists earlier
   todos. There is no new `Listening on` line; `/openapi.json` and `/docs` stay
   available.

The todo store is in memory and resets when its plugin restarts.
`DELETE /todos/:id` returns 204 when it removes a todo and 404 when the id is
absent.

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

## Files

| Files                                           | Role                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `graft.yml`                                     | The router, the listener, the route plugins, the HttpApi composer and its Scalar page. |
| `src/plugins/health.ts`                         | A health mount.                                                                        |
| `src/plugins/inspector.ts`                      | A mount showing the live fork tree.                                                    |
| `src/TodoStore.ts`, `src/plugins/todo-store.ts` | A dependency used by the todo routes.                                                  |
| `src/api/Todos.ts`                              | Shared HttpApi contract and typed errors.                                              |
| `src/plugins/todos.ts`                          | GET, POST and DELETE routes in one mount.                                              |
| `src/plugins/events.ts`                         | An SSE mount, cut on unload.                                                           |
| `test/http-gateway.test.ts`                     | Tests against a real server on an OS-assigned port.                                    |
