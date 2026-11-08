# MCP tools

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An MCP server whose tools are Graft plugins. `graft.yml` uses stdio without an
HTTP listener; `graft.http.yml` serves the same contributors over HTTP.

## Run it

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/mcp-tools && pnpm start"
```

```toml
[mcp_servers.graft-tools]
command = "sh"
args = ["-c", "cd /path/to/graft/samples/mcp-tools && npx graft start --stdio"]
```

## Edit it

Stop the server, edit `src/plugins/clock.ts` or a configuration file, rebuild
and restart it. `start` reads one revision and rejects `--watch`. Reconnect the
client after restarting.

## Resources, prompts and elicitation

| Entry     | Operations                            |
| --------- | ------------------------------------- |
| `clock`   | `current_time`                        |
| `todo`    | `add_todo`, `list_todos`              |
| `content` | `greeting://Ada`, `greet`, `ask_name` |

## Connect over HTTP

```sh
devenv shell -- bash -c "cd samples/mcp-tools && pnpm start:http"
```

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```

## Tests

```sh
devenv shell -- pnpm --filter @graftland/sample-mcp-tools test
```

The tests directly embed cooperative plugins and call them through an in-process
MCP client. They verify configuration and protocol behavior, not kernel
isolation.
