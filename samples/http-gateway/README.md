# HTTP gateway

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Routes, an Effect HttpApi contract and a typed client share one HTTP listener.
`/openapi.json` publishes the API and `/docs` serves Scalar.

## Run it

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

## Edit it

Edit a source module or `graft.yml`, stop the process, rebuild and start again.
`start` reads one revision and rejects `--watch`.

## Tests

```sh
devenv shell -- pnpm --filter @graftland/sample-http-gateway test
```

The tests directly embed cooperative plugins and use a real listener on an
OS-assigned port. They verify route cleanup and composition, not kernel
isolation.

## Files

| File                        | Role                                           |
| --------------------------- | ---------------------------------------------- |
| `graft.yml`                 | Listener, router, mounts and API documentation |
| `src/plugins/health.ts`     | `/health`                                      |
| `src/plugins/events.ts`     | `/events`                                      |
| `src/plugins/todo-store.ts` | In-memory `TodoStore`                          |
| `src/plugins/todos.ts`      | GET, POST and DELETE                           |
| `src/api/Todos.ts`          | HttpApi contract                               |
| `dist/`                     | Built modules selected by configuration        |
