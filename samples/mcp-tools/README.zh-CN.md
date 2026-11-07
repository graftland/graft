# MCP 工具

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一个供 Claude
Code 或 Codex 使用的 MCP 服务器，它的工具都是 Graft 插件。客户端连接期间修改某个工具，下一次调用就运行新代码。

stdio 配置 `graft.yml`
不启动 HTTP 监听器，每个客户端可以启动自己的进程。`graft.http.yml`
通过 HTTP 提供相同的贡献项。

| 插件         | 文件                                 | 展示的内容                                     |
| ------------ | ------------------------------------ | ---------------------------------------------- |
| `mcp`        | `@graftland/plugin-mcp-server`       | 发布服务器选项。                               |
| `stdio`      | `@graftland/plugin-mcp-server/stdio` | stdio MCP 传输。                               |
| `router`     | `@graftland/plugin-http/router`      | 共享 HTTP 路由器。                             |
| `listener`   | `@graftland/plugin-http`             | 端口 8080 的监听器。                           |
| `http`       | `@graftland/plugin-mcp-server/http`  | Streamable HTTP 传输。                         |
| `content`    | `src/plugins/content.ts`             | 资源模板、提示词、补全与征询。                 |
| `clock`      | `src/plugins/clock.ts`               | 一个工具插件：`current_time`。                 |
| `todo-store` | `src/plugins/todo-store.ts`          | 发布 `TodoStore` 服务。                        |
| `todo`       | `src/plugins/todo.ts`                | `add_todo` 和 `list_todos`，存储存在时才提供。 |

## 运行

在仓库根目录先构建一次：

```sh
devenv shell -- pnpm build
```

然后让客户端指向这个示例。Claude Code：在 `samples/mcp-tools` 中运行

```sh
claude mcp add graft-tools -- npx graft start --stdio --watch
```

Codex：在 `~/.codex/config.toml` 中加入（路径换成你的检出目录）：

```toml
[mcp_servers.graft-tools]
command = "sh"
args = ["-c", "cd /path/to/graft/samples/mcp-tools && npx graft start --stdio --watch"]
```

客户端连接后：

1. 询问当前时间。修改 `src/plugins/clock.ts` 中的 `current_time`
   并保存，再问一次：答案来自新代码，无需重连。
2. 给 `graft.yml` 中的 `todo-store` 配置项加上 `disabled: true`
   并保存。`add_todo` 和 `list_todos`
   从客户端的工具中消失；删除这一行，它们就回来了。
3. 让 `clock.ts` 中的 `handlers` 失败，例如改为 `Effect.fail("broken")`
   并保存。Graft 向 stderr 记录
   `Kept the previous code: plugin "clock" failed to start`，时钟继续应答。

`devenv shell -- pnpm --filter @graftland/sample-mcp-tools test`
通过进程内的 MCP 客户端检查这些工具。

## 资源、提示词和征询

`content` 条目提供 `greeting://{name}` 和 `greet` 提示词。读取
`greeting://Ada`，再以 `{ "name": "Ada" }` 获取 `greet`。用前缀 `A` 补全其
`name` 参数，会得到 `Ada`。

征询工具支持具备表单征询能力的客户端。MCP
2026-07-28 使用需要输入的结果和后续调用；旧版客户端接收征询请求。

## 通过 HTTP 连接

从 `samples/mcp-tools` 启动一个长期运行的 HTTP 服务器：

```sh
npx graft start graft.http.yml --watch
```

多个客户端共享
`http://127.0.0.1:8080/mcp`。此配置没有 stdio 传输，不依赖 stdin 保持打开。按 Ctrl+C 停止。通过 HTTP 练习贡献项重载时，编辑
`graft.http.yml`。

Claude Code：

```sh
claude mcp add --transport http graft-tools-http http://127.0.0.1:8080/mcp
```

Codex：用此条目替换 stdio 条目：

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```
