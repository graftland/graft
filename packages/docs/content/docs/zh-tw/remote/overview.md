---
title: 概覽
description: 把外掛放進子行程、Node worker，或交給 runner 執行。
---

把外掛放進子行程、Node
worker，或交給 runner 執行。本頁協助你選擇執行位置；呼叫端仍使用一般的 Graft 服務。

## 選擇執行方式

- **直連**：`local` 啟動子行程，`worker` 在宿主行程中啟動 Node
  worker。兩者都不需要 runner，每次啟用的 generation 都是 1。
- **Runner**：宿主連線到獨立執行的 runner，由它啟動外掛行程。runner 持久保存 generation，並在確認舊行程退出後才接受替換實例。

宿主載入 `name: remote`。runner 在自己的設定中載入 `name: remote/runner`，用
`graft-remote serve --config runner.yml` 啟動。

Remote 隔離執行，不隔離權限。需要權限邊界時用容器或虛擬機；同一行程中的服務可見性用[隔離](../../isolation/)控制。

## 試看看

[建置好契約與實作](../host/#定義契約)後，載入這個條目：

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

執行 `graft start`。把 `local: {}` 換成 `worker: {}` 就能使用 Node
worker，呼叫端不用改。

跟著
[06 · 遠端外掛](https://github.com/graftland/graft/tree/main/samples/06-remote/README.zh-TW.md)體驗 local、worker 與 runner。[聊天機器人](https://github.com/graftland/graft/tree/main/samples/chat-bot/README.zh-TW.md)則把天氣整合放進了子行程。

## 接下來

- [宿主](../host/)：YAML、TypeScript 與共用服務。
- [Runner](../runner/)：安裝、設定與 SSH。
- [傳輸與驗證](../transport-auth/)：組合、WARN 與信任邊界。
- [替換、租約與停止](../lifecycle/)：generation、期限與失敗處理。
- [撰寫能力外掛](../capabilities/)：擴充 remote，並執行共用測試。
