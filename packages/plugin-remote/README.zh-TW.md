# @graftland/plugin-remote

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

把 Graft 外掛放到別處執行：子行程、Node
worker，或透過 runner 放到另一台機器上。使用它的外掛照常注入它的[服務](https://graftland.github.io/graft/zh-tw/services/)，需要改的只有它的[設定項目](https://graftland.github.io/graft/zh-tw/config-file/)。

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

Remote 隔離的是執行，不是權限。需要權限邊界時，請把 runner 放進容器或虛擬機器。

## 文件

- [Remote](https://graftland.github.io/graft/zh-tw/remote/overview/)：Remote 做什麼，以及它的限制。
- [宿主設定項目](https://graftland.github.io/graft/zh-tw/remote/hosts/)：契約、`remote`
  設定項目、服務與錯誤。
- [Runner](https://graftland.github.io/graft/zh-tw/remote/runners/)：用
  `graft start runner.yml` 在另一台機器上執行外掛。
- [傳輸與驗證](https://graftland.github.io/graft/zh-tw/remote/transport-auth/)
- [替換與停止](https://graftland.github.io/graft/zh-tw/remote/lifecycle/)
- [能力外掛](https://graftland.github.io/graft/zh-tw/remote/capabilities/)
- [API 參考](https://graftland.github.io/graft/reference/plugin-remote/readme/)

## 範例

- [06 · 遠端外掛](../../samples/06-remote/README.zh-TW.md)
- [聊天機器人](../../samples/chat-bot/README.zh-TW.md)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
