# MCP tools

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An MCP server for Claude Code or Codex whose tools are Graft plugins. Change a
tool while the client is connected, and its next call runs the new code.

The stdio configuration `graft.yml` opens no HTTP listener. Each client can
start its own process. `graft.http.yml` serves the same contributors over HTTP.

| Plugin       | File                                 | What it shows                                             |
| ------------ | ------------------------------------ | --------------------------------------------------------- |
| `mcp`        | `@graftland/plugin-mcp-server`       | Publishes server options.                                 |
| `stdio`      | `@graftland/plugin-mcp-server/stdio` | The stdio MCP transport.                                  |
| `router`     | `@graftland/plugin-http/router`      | The shared HTTP router.                                   |
| `listener`   | `@graftland/plugin-http`             | The listener on port 8080.                                |
| `http`       | `@graftland/plugin-mcp-server/http`  | The Streamable HTTP transport.                            |
| `content`    | `src/plugins/content.ts`             | A resource template, prompt, completion and elicitation.  |
| `clock`      | `src/plugins/clock.ts`               | A tool plugin: `current_time`.                            |
| `todo-store` | `src/plugins/todo-store.ts`          | Publishes the `TodoStore` service.                        |
| `todo`       | `src/plugins/todo.ts`                | `add_todo` and `list_todos`, served while a store exists. |

## Run it

From the repository root, build once:

```sh
devenv shell -- pnpm build
```

Then point the client at the sample. For Claude Code, run this in
`samples/mcp-tools`:

```sh
claude mcp add graft-tools -- npx graft start --stdio --watch
```

For Codex, add to `~/.codex/config.toml`, with your checkout's path:

```toml
[mcp_servers.graft-tools]
command = "sh"
args = ["-c", "cd /path/to/graft/samples/mcp-tools && npx graft start --stdio --watch"]
```

Then, with the client connected:

1. Ask for the time. Edit `current_time` in `src/plugins/clock.ts` and save. Ask
   again: the answer comes from the new code, without reconnecting.
2. Add `disabled: true` to the `todo-store` entry in `graft.yml` and save.
   `add_todo` and `list_todos` disappear from the client's tools. Remove the
   line, and they return.
3. Make `handlers` in `clock.ts` fail, for example with `Effect.fail("broken")`,
   and save. Graft logs `Kept the previous code: plugin "clock" failed to start`
   to stderr, and the clock keeps answering.

`devenv shell -- pnpm --filter @graftland/sample-mcp-tools test` checks the
tools through an in-process MCP client.

## Resources, prompts and elicitation

The `content` entry offers `greeting://{name}` and the `greet` prompt. Read
`greeting://Ada`, then get `greet` with `{ "name": "Ada" }`. Complete its `name`
argument with prefix `A` to receive `Ada`.

Call `ask_name` on a client with form elicitation and submit a name. MCP
2026-07-28 uses an input-required result and a follow-up call; legacy clients
receive an elicitation request.

## Connect over HTTP

Run one long-lived HTTP server from `samples/mcp-tools`:

```sh
npx graft start graft.http.yml --watch
```

Multiple clients share `http://127.0.0.1:8080/mcp`. This configuration has no
stdio transport and does not depend on stdin staying open. Stop it with Ctrl+C.
Edit `graft.http.yml` when following the contributor reload steps over HTTP.

For Claude Code:

```sh
claude mcp add --transport http graft-tools-http http://127.0.0.1:8080/mcp
```

For Codex, use this entry instead of the stdio entry:

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```
