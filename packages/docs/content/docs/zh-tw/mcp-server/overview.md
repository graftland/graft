---
title: MCP 伺服器
description: 用核心、傳輸和貢獻外掛組成 MCP 伺服器。
---

`@graftland/plugin-mcp-server`
透過 Effect 的 MCP 伺服器提供工具、資源和提示詞。**核心**釋出
`Server`，同級傳輸外掛消費它。貢獻外掛載入或卸載時，用戶端無需重新連線。

## 執行 stdio

```yaml
- name: "@graftland/plugin-mcp-server"
  config: { name: notes, version: 1.0.0 }
- name: "@graftland/plugin-mcp-server/stdio"
- name: ./plugins/notes.ts
```

執行 `graft start --stdio`。使用 `Effect.log*`
記錄日誌；stdout 屬於協定。[範例](https://github.com/graftland/graft/tree/main/samples/mcp-tools)包含可執行的用戶端設定。

| 條目                                 | 短名稱             | 職責                        |
| ------------------------------------ | ------------------ | --------------------------- |
| `@graftland/plugin-mcp-server`       | `mcp-server`       | 釋出伺服器選項              |
| `@graftland/plugin-mcp-server/stdio` | `mcp-server/stdio` | 執行 Effect 的 stdio 伺服器 |
| `@graftland/plugin-mcp-server/http`  | `mcp-server/http`  | 掛載 Streamable HTTP 路由   |

## 提供 HTTP

將共用的 [HTTP 路由器和監聽器](../../http/)與核心放在一起，並以一個長期執行的
`graft start`
執行這份設定。stdio 放在單獨的設定中：MCP 用戶端每個工作階段啟動一個 stdio 行程，固定連接埠會衝突。兩份設定可以列出相同的貢獻外掛。

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: "@graftland/plugin-mcp-server"
  config: { name: notes, version: 1.0.0 }
- name: "@graftland/plugin-mcp-server/http"
  config:
    path: /mcp
    allowedOrigins: [https://app.example.com]
- name: ./plugins/notes.ts
```

| 欄位                   | 預設值 | 規則                                                      |
| ---------------------- | ------ | --------------------------------------------------------- |
| `path`                 | `/mcp` | 共用路由器上的端點                                        |
| `allowedOrigins`       | 無     | 拒絕未明確列出的 `Origin`；沒有該請求標頭的請求仍可存取   |
| `authorization.scopes` | 無     | 設定後要求共用的 `Authorization` 服務及全部列出的權限範圍 |

### 要求授權

用下方受保護的條目取代上方的 HTTP 條目，並加入 OAuth 外掛。JWT 驗證器還需要已發布的
`HttpClient`；見 [HTTP 授權](../../http-authorization/)。

```yaml
- name: "@graftland/plugin-http/oauth/jwt"
  config:
    issuer: https://auth.example.com
    audience: https://mcp.example.com/mcp
    jwksUrl: https://auth.example.com/jwks
- name: "@graftland/plugin-http/oauth"
  config:
    resource: https://mcp.example.com/mcp
    authorizationServers: [https://auth.example.com]
- name: "@graftland/plugin-mcp-server/http"
  config:
    path: /mcp
    authorization: { scopes: ["notes:read"] }
```

| 狀態                       | 結果                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `Authorization` 缺少或撤回 | 受保護路徑回傳 404                                           |
| 授權可用，但缺少權杖       | 401，帶 `WWW-Authenticate` 和受保護資源後設資料              |
| 缺少要求的權限範圍         | 403 `insufficient_scope`                                     |
| 權杖有效                   | `Principal` 到達工具處理函式，並覆蓋外掛中的同鍵服務         |
| OAuth 外掛載入或卸載       | 未保護的傳輸保持目前啟用狀態                                 |
| 監聽器連接埠改變           | MCP 路由保持目前啟用狀態                                     |
| 舊版工作階段 DELETE        | 回傳 204，之後存取該工作階段回傳 404。受保護端點仍檢查授權。 |

## 設定核心

| 欄位                                                 | 預設值                       | 規則                                                             |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `name`, `version`                                    | `graft`, `0.0.0`             | 伺服器身分                                                       |
| `description`, `websiteUrl`, `icons`, `instructions` | 無                           | Effect 伺服器後設資料                                            |
| `protocols`                                          | 全部 Effect 介面卡，最新優先 | 包含 `2026-07-28` 和 `2025-11-25`；不能為空                      |
| `cache`                                              | 無                           | `discover`, `tools`, `resources`, `resourceTemplates`, `prompts` |
| `cache.<list>.ttl`                                   | 設定時必填                   | 非負毫秒數；接受數字或數字字串                                   |
| `cache.<list>.cacheScope`                            | `private`                    | 僅支援 `private`                                                 |

`resources/read`
的快取提示始終為私有，存活時間為零。清單回傳全部條目，不分頁。工具、資源和提示詞即使清單為空，也始終宣告為可用能力。

## 生命週期

| 變化                         | 結果                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| 貢獻外掛載入、重新載入或停止 | 清單改變；下次呼叫使用當前處理函式                         |
| 貢獻外掛停止                 | 中斷其正在執行的呼叫並等待結束                             |
| 同一清單中的兩個貢獻衝突     | 隱藏所有衝突貢獻；每個傳輸記錄 `Conflict`                  |
| 一個貢獻註冊失敗             | 該項保持隱藏；其他項仍然可用                               |
| 核心設定改變                 | 所有傳輸重啟；用戶端重新連線；貢獻外掛繼續執行             |
| 一個傳輸改變或停止           | 僅重啟或停止該傳輸                                         |
| 擴充宣告改變                 | 記錄警告；該傳輸下次啟動時生效                             |
| stdin 結束                   | 等待正在執行的工作結束，再由 `Application.finish` 停止應用 |

取消尚未結束的
`subscriptions/listen`，stdio 才能在 EOF 後排空。重新載入核心或傳輸不會結束應用。在
`graft start` 下，`Application.claimProtocol`
保證 stdio 獨佔。嵌入時，由嵌入方決定誰讀取 stdio。每個行程最多執行一個 stdio 傳輸。

## 隔離伺服器

在包含核心、傳輸和貢獻外掛的組上，一起隔離以下七個鍵。所有鍵都帶有
`@graftland/plugin-mcp-server/` 字首。

| 鍵字尾                  | 型別   | 用途             |
| ----------------------- | ------ | ---------------- |
| `Server/Server`         | 服務   | 每個領域一個核心 |
| `Catalog/Offered`       | 事件   | 拉取當前貢獻     |
| `Catalog/Changed`       | 事件   | 等待每個投影同步 |
| `Resources/Updated`     | 事件   | 通知資源訂閱者   |
| `Middleware/Middleware` | 瀑布流 | 呼叫策略         |
| `Middleware/Visible`    | 事件   | 按請求判斷可見性 |
| `Extensions/Declared`   | 事件   | 取得擴充宣告快照 |

```ts
import { Array } from "effect"

import { isolate } from "@graftland/plugin-mcp-server/Server"

export const serverIsolation = {
	isolate: Array.map(isolate, (key) => ({ key })),
}
```

在 YAML 中，在組的 `isolate` 下將每個完整鍵對映到
`true`。第二個組可以用錨點複用該對映。要向兩個伺服器提供同一個貢獻外掛，在兩個組中都列出它。省略某個鍵就會共享它；省略
`Middleware` 或 `Visible` 就會共享對應策略。同一領域中的第二個核心會報
`ServiceConflict`。

核心、傳輸和貢獻外掛必須執行在同一個行程中。不要放在 Remote 下：`Server`
攜帶 Effect 層。

兩個組可以共用一個監聽器。保留共用的 HTTP 路由鍵，將七個 MCP 鍵一起隔離：

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 8080 }
- name: public
  id: public
  group: true
  isolate: &mcp
    "@graftland/plugin-mcp-server/Server/Server": true
    "@graftland/plugin-mcp-server/Catalog/Offered": true
    "@graftland/plugin-mcp-server/Catalog/Changed": true
    "@graftland/plugin-mcp-server/Resources/Updated": true
    "@graftland/plugin-mcp-server/Middleware/Middleware": true
    "@graftland/plugin-mcp-server/Middleware/Visible": true
    "@graftland/plugin-mcp-server/Extensions/Declared": true
  config:
    - name: "@graftland/plugin-mcp-server"
      config: { name: notes-public }
    - name: "@graftland/plugin-mcp-server/http"
      config: { path: /mcp }
    - name: ./plugins/search.ts
- name: admin
  id: admin
  group: true
  isolate: *mcp
  config:
    - name: "@graftland/plugin-mcp-server"
      config: { name: notes-admin }
    - name: "@graftland/plugin-mcp-server/http"
      config: { path: /admin/mcp }
    - name: ./plugins/search.ts
    - name: ./plugins/admin.ts
```
