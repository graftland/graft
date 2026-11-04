# 06 · 遠端外掛

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

greeter 仍是一般外掛。這次由你決定它在哪裡執行。welcome 一樣注入 `Greeter`，呼叫
`greet("Alice")`。

你會學到：

- 把一個條目換成 `name: remote`，呼叫端不用改。
- 只改 `connect`，讓同一個外掛在子行程、Node worker 或 runner 上執行。
- 共用契約，不把實作模組匯入宿主。

## 執行

從儲存庫根目錄開始：

```sh
devenv shell -- pnpm build
cd samples/06-remote
devenv shell -- pnpm start
```

看到 `Hello, Alice!` 後，讓程式繼續執行，邊改邊看。

## 替換一個條目

一般的服務提供者條目寫法如下：

```yaml
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello
```

本例的 `graft.yml` 只把這個條目換成：

```yaml
- id: greeter
  name: remote
  config:
    contract: "@graftland/sample-remote/contract"
    connect:
      local: {}
    config:
      greeting: Hello
```

`welcome` 條目和 [`src/welcome.ts`](src/welcome.ts) 都不變。
[`src/greeter.ts`](src/greeter.ts) 也仍是一般外掛；
[`src/contract.ts`](src/contract.ts)
描述它的服務。建置後的 JavaScript 能由子行程獨立載入，不依賴宿主的載入器。

1. 把 `greeting: Hello` 改成 `greeting: Hi`
   並儲存。提供者重新啟動後，welcome 印出 `Hi, Alice!`。
2. 只把 `connect` 換成：

```yaml
connect:
  worker: {}
```

儲存後，問候語就來自 Node
worker 了。worker 與宿主共用行程，隔離執行，**不隔離權限**。local 使用獨立行程，同樣保留目前使用者的作業系統權限。

## 換到 runner

另開一個終端機，在本目錄執行：

```sh
devenv shell -- pnpm runner
# Runs: graft-remote serve --config runner.yml
```

建置時已把本例的套件複製到 `.cache/installation`，供 [`runner.yml`](runner.yml)
使用。部署到另一台機器時，在那台機器安裝建置好的外掛套件及相依套件；宿主不會上傳程式碼。

只改 `graft.yml` 的 `connect` 並儲存：

```yaml
connect:
  url: ws://127.0.0.1:7443
  auth:
    none: {}
```

問候語沒有改變，這次由 runner 啟動子行程。持久化的 `greeter`
條目 id 就是實例名稱；替換時先確認舊子行程退出，再以更大的 generation 啟動新實例。

你會看到 WARN：`ws` 沒有加密，`none`
不驗證呼叫端身分。本例只在回環位址上體驗流程；部署時請使用 wss 與驗證。詳見[遠端外掛文件](../../packages/docs/content/docs/zh-tw/remote.md)。

結束時先在宿主終端機按 **Ctrl+C**，再停止 runner。執行中可以改業務設定與
`connect`；修改契約後，需要重新建置並重新啟動宿主。

## 下一步

[聊天機器人](../chat-bot/README.zh-TW.md)把天氣整合放進子行程，其他指令留在宿主。
[其他範例](../README.zh-TW.md)展示更多組合方式。
