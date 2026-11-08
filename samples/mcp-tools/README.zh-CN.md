# MCP 工具

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一个工具由 Graft 插件提供的 MCP 服务器。`graft.yml`
使用 stdio，不启动 HTTP 监听器；`graft.http.yml` 通过 HTTP 提供相同的贡献者。

## 运行

```sh
devenv shell -- pnpm build
devenv shell -- bash -c "cd samples/mcp-tools && pnpm start"
```

```toml
[mcp_servers.graft-tools]
command = "sh"
args = ["-c", "cd /path/to/graft/samples/mcp-tools && npx graft start --stdio"]
```

## 修改

停止服务器，修改 `src/plugins/clock.ts` 或配置文件，重新构建并启动。`start`
读取一个版本，不支持 `--watch`。重启后重新连接客户端。

## 资源、提示词与 elicitation

| Entry     | Operations                            |
| --------- | ------------------------------------- |
| `clock`   | `current_time`                        |
| `todo`    | `add_todo`, `list_todos`              |
| `content` | `greeting://Ada`, `greet`, `ask_name` |

## 通过 HTTP 连接

```sh
devenv shell -- bash -c "cd samples/mcp-tools && pnpm start:http"
```

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```

## 测试

```sh
devenv shell -- pnpm --filter @graftland/sample-mcp-tools test
```

测试直接嵌入协作式插件，通过进程内 MCP 客户端调用。它们验证配置和协议行为，不证明内核隔离。
