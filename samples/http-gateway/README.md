# HTTP gateway

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A real HTTP server whose routes come from plugins listed in `graft.yml`. You can
add, remove, and reconfigure routes by editing that file. You can change their
code by saving it. The process keeps running the whole time.

## The problem

A long-running HTTP service usually sets up its routes once at startup. To
change what it serves, you have two choices. One is a restart, which drops
connections and in-memory state. The other is a hand-written admin layer that
changes the router. That layer must also remember to close whatever each feature
opened. Features that depend on a store need startup ordering. Turning the store
off needs a plan for the routes that use it.

## What Graft does instead

- **The server knows nothing about routes.** `server` listens and offers each
  request to the `Route` event with `Event.bail`. A route is an `Event.on`
  handler inside a plugin, so it exists exactly as long as that plugin is
  loaded.
- **The config file is the source of truth.** `graft start --watch` reconciles
  the running tree with `graft.yml` on every save. Only the entries that changed
  are touched. If you disable `todo-store`, the server keeps listening. If you
  change the server's `port`, the server restarts and no route is touched.
- **Dependencies are explicit.** `todos` injects `TodoStore`. While the store is
  disabled, `todos` is `Pending` and its routes answer 404. Enable the store
  again and the routes return. Nothing in `todos` checks for the store.
- **Code reloads in place.** When you save a plugin module, Graft imports the
  new version and replaces the running plugins with it. The process does not
  restart. As the
  [hot reload docs](../../packages/docs/content/docs/hot-reload.md) explain, a
  code change restarts every plugin loaded from a module, the server included.
- **You can see the tree.** `GET /_graft` prints the live fork tree with each
  plugin's state, including what a `Pending` plugin is waiting for.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
cd samples/http-gateway
devenv shell -- pnpm start
```

The server listens on port 3000. In another terminal:

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

Then, while it runs:

1. Add `disabled: true` to the `todo-store` entry and save. The log shows
   `Todo store closed` and nothing else. `/todos` answers 404, and `/_graft`
   shows `todos` as `Pending (waiting for .../TodoStore)`. Remove the line again
   and `/todos` is back.
2. Change the server's `port` to `3001` and save. The log shows
   `Stopped listening on http://localhost:3000` and
   `Listening on http://localhost:3001`. The store keeps its todos.
3. Change the text in `src/plugins/health.ts` and save. The log shows
   `Reloaded 5 plugin module(s)` and `/health` answers with the new text.

The todo store is in memory, so its todos are reset whenever it restarts.

`devenv shell -- pnpm --filter @graftland/sample-http-gateway test` starts the
server on a free port and checks the route and config behavior over HTTP.

## Files

| File                        | What it is                                                   |
| --------------------------- | ------------------------------------------------------------ |
| `graft.yml`                 | The entries `graft start` loads.                             |
| `src/Gateway.ts`            | The `Route` event, `route()`, and the `Gateway` address key. |
| `src/TodoStore.ts`          | The `TodoStore` service key.                                 |
| `src/plugins/server.ts`     | The HTTP server.                                             |
| `src/plugins/health.ts`     | `GET /health`.                                               |
| `src/plugins/inspector.ts`  | `GET /_graft`, the live fork tree.                           |
| `src/plugins/todo-store.ts` | An in-memory `TodoStore`.                                    |
| `src/plugins/todos.ts`      | `GET /todos` and `POST /todos`.                              |
| `test/http-gateway.test.ts` | Tests over real HTTP.                                        |
