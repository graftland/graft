# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

在子行程、Node
worker 或 runner 執行 Graft 外掛。契約宣告跨邊界的服務，消費者保留原來的介面。宿主只匯入契約，契約的
`module` 指向實作；先將兩者建置為 JavaScript。

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

執行 `graft start`，或以 `Graft.plugin(entry)` 載入 TS 外掛：

```ts
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { worker: {} },
	config: { greeting: "Hello" },
})
```

TS 與 YAML 共用
`connect`：local、worker、url（ws/wss）、unix、command。驗證可選 mtls、bearer、jwt、none，或第三方
`{ name, config }`
引用。不必另寫能力 entry 或服務鍵字串。TS 憑證也允許 Effect 或
`{ inject, read }`。自訂宿主須為 Graft 提供 `NodeServices.layer` 與
`SecureRandom.layerWebCrypto`。

runner 設定：

```yaml
- name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth: { mtls: { ca: ./certs/ca.crt } }
```

執行
`graft-remote serve --config runner.yml`。預先安裝外掛套件，保留狀態目錄，並由外部 supervisor 管理 runner 及後代行程。`graft-remote certificates`
可產生憑證。宿主保存的條目 id 預設就是實例名稱；runner 確認舊行程退出後才接受替換，並遞增 generation。租約與三種停止結果見指南。

worker 不隔離權限；unix 依賴檔案權限；stdio 依賴 SSH 等外部機制。token 建議走 wss，被竊後在有效期內可以重放。JWT 只在 upgrade 驗證一次。修改契約後須重啟宿主，契約匯入不參與 HMR。

公開 API：套件根目錄 default、`plugin`、`Contract`、`Instance`、公開錯誤；`/runner`；`/Auth`、`/Transport`、`/Errors`、`/Contract`、`/Testing`；以及
`host/*`、`runner/*`
能力模組。`/internal/bin`、`/internal/worker`、`/internal/watchdog`
僅是執行檔路徑，**不是公開 API**。

- [Remote](https://graftland.github.io/graft/zh-tw/remote/)
- [Capabilities](https://graftland.github.io/graft/zh-tw/remote-capabilities/)
- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

此工作區套件仍為 private。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
