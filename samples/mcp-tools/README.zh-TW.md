# MCP 工具

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一個供 Claude
Code 或 Codex 使用的 MCP 伺服器，它的工具都是 Graft 外掛。用戶端連線期間修改某個工具，下一次呼叫就執行新程式碼。

stdio 設定檔 `graft.yml`
不啟動 HTTP 監聽器，每個用戶端可以啟動自己的行程。`graft.http.yml`
透過 HTTP 提供相同的貢獻項。

| 外掛         | 檔案                                 | 展示的內容                                     |
| ------------ | ------------------------------------ | ---------------------------------------------- |
| `mcp`        | `@graftland/plugin-mcp-server`       | 發布伺服器選項。                               |
| `stdio`      | `@graftland/plugin-mcp-server/stdio` | stdio MCP 傳輸。                               |
| `router`     | `@graftland/plugin-http/router`      | 共用 HTTP 路由器。                             |
| `listener`   | `@graftland/plugin-http`             | 連接埠 8080 的監聽器。                         |
| `http`       | `@graftland/plugin-mcp-server/http`  | Streamable HTTP 傳輸。                         |
| `content`    | `src/plugins/content.ts`             | 資源範本、提示詞、補全與徵詢。                 |
| `clock`      | `src/plugins/clock.ts`               | 一個工具外掛：`current_time`。                 |
| `todo-store` | `src/plugins/todo-store.ts`          | 發布 `TodoStore` 服務。                        |
| `todo`       | `src/plugins/todo.ts`                | `add_todo` 和 `list_todos`，儲存存在時才提供。 |

## 執行

在儲存庫根目錄先建置一次：

```sh
devenv shell -- pnpm build
```

然後讓用戶端指向這個範例。Claude Code：在 `samples/mcp-tools` 中執行

```sh
claude mcp add graft-tools -- npx graft start --stdio --watch
```

Codex：在 `~/.codex/config.toml` 中加入（路徑換成你的檢出目錄）：

```toml
[mcp_servers.graft-tools]
command = "sh"
args = ["-c", "cd /path/to/graft/samples/mcp-tools && npx graft start --stdio --watch"]
```

用戶端連線後：

1. 詢問目前時間。修改 `src/plugins/clock.ts` 中的 `current_time`
   並儲存，再問一次：答案來自新程式碼，不必重新連線。
2. 在 `graft.yml` 的 `todo-store` 項目加上 `disabled: true` 並儲存。`add_todo`
   和 `list_todos` 從用戶端的工具中消失；刪除這一行，它們就回來了。
3. 讓 `clock.ts` 中的 `handlers` 失敗，例如改成 `Effect.fail("broken")`
   並儲存。Graft 向 stderr 記錄
   `Kept the previous code: plugin "clock" failed to start`，時鐘繼續應答。

`devenv shell -- pnpm --filter @graftland/sample-mcp-tools test`
透過行程內的 MCP 用戶端檢查這些工具。

## 資源、提示詞和徵詢

`content` 條目提供 `greeting://{name}` 和 `greet` 提示詞。讀取
`greeting://Ada`，再以 `{ "name": "Ada" }` 取得 `greet`。用字首 `A` 補全其
`name` 參數，會得到 `Ada`。

徵詢工具支援具備表單徵詢能力的用戶端。MCP
2026-07-28 使用需要輸入的結果和後續呼叫；舊版用戶端接收徵詢請求。

## 透過 HTTP 連線

從 `samples/mcp-tools` 啟動一個長期執行的 HTTP 伺服器：

```sh
npx graft start graft.http.yml --watch
```

多個用戶端共用
`http://127.0.0.1:8080/mcp`。此設定沒有 stdio 傳輸，不依賴 stdin 保持開啟。按 Ctrl+C 停止。透過 HTTP 練習貢獻項重載時，編輯
`graft.http.yml`。

Claude Code：

```sh
claude mcp add --transport http graft-tools-http http://127.0.0.1:8080/mcp
```

Codex：用此條目取代 stdio 條目：

```toml
[mcp_servers.graft-tools-http]
url = "http://127.0.0.1:8080/mcp"
```
