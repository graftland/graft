# MCP 工具

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

一個工具由 Graft 外掛提供的 MCP 伺服器。`graft.yml`
使用 stdio，不啟動 HTTP 接聽器；`graft.http.yml` 透過 HTTP 提供相同的貢獻者。

## 執行

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

停止伺服器，修改 `src/plugins/clock.ts` 或設定檔，重新建置並啟動。`start`
讀取一個版本，不支援 `--watch`。重新啟動後重新連線用戶端。

## 資源、提示詞與 elicitation

| Entry     | Operations                            |
| --------- | ------------------------------------- |
| `clock`   | `current_time`                        |
| `todo`    | `add_todo`, `list_todos`              |
| `content` | `greeting://Ada`, `greet`, `ask_name` |

## 透過 HTTP 連線

```sh
devenv shell -- bash -c "cd samples/mcp-tools && pnpm start:http"
```

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```

## 測試

```sh
devenv shell -- pnpm --filter @graftland/sample-mcp-tools test
```

測試直接嵌入協作式外掛，透過行程內 MCP 用戶端呼叫。它們驗證設定和協定行為，不證明核心隔離。
