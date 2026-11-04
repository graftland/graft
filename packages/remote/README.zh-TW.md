# @graftland/plugin-remote

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

把 Graft 外掛放到別處執行：子行程、Node
worker，或透過 runner 放到另一台機器上。使用它的外掛照常注入它的服務，需要改的只有它的設定項目。

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

- [概覽](https://graftland.github.io/graft/zh-tw/remote/overview/)：Remote 解決什麼問題，各部分如何配合。
- [快速上手](https://graftland.github.io/graft/zh-tw/remote/getting-started/)：把外掛移到子行程或 worker。
- [在另一台機器上執行外掛](https://graftland.github.io/graft/zh-tw/remote/runners/)：用
  `graft-remote serve` 部署 runner。
- [選擇傳輸與驗證](https://graftland.github.io/graft/zh-tw/remote/transport-auth/)
- [重新啟動、替換與停止](https://graftland.github.io/graft/zh-tw/remote/restarts/)
- [編寫自己的傳輸或驗證](https://graftland.github.io/graft/zh-tw/remote/capabilities/)
- [參考](https://graftland.github.io/graft/zh-tw/remote/reference/)

## 範例

- [06 · 遠端外掛](../../samples/06-remote/README.zh-TW.md)
- [聊天機器人](../../samples/chat-bot/README.zh-TW.md)

本工作區套件仍為 private。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
