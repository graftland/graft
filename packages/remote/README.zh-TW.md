# @graftland/remote

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

讓 Graft 外掛在子行程、Node
worker 或 runner 上執行。宣告跨邊界服務後，服務使用者仍使用原來的介面。

契約與實作分開放，宿主只匯入契約。先把兩者編譯成 JavaScript，再載入能力外掛與入口：

```ts
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

```yaml
- name: "@graftland/remote/host/local"
- name: ./entry.ts
```

執行緒模式用 `Remote.worker()` 和
`host/worker`；worker 與宿主共用行程和權限。連線到 runner 用
`Remote.runner({ transport, auth })`：支援 websocket（ws/wss）、unix
socket 和 command/stdio，並依傳輸選擇 mTLS、bearer、JWT 或 none。須明確載入對應的
`host/*`、`host/auth/*` 外掛；缺少能力時代理保持 Pending， `Remote.plugin`
不會自動安裝提供者。

runner 透過 `graft-remote serve --config runner.yml`
或命令列簡寫啟動。事先安裝外掛套件，保留狀態目錄。部署憑證可用
`graft-remote certificates` 簽發。透過 `graft.yml`
載入時，儲存的項目 id 預設就是實例名稱。

自行嵌入 Graft 時，為執行環境提供 `NodeServices.layer` 和 `effect/crypto` 的
`SecureRandom.layerWebCrypto`。

- [遠端外掛指南](https://graftland.github.io/graft/zh-tw/remote/)
- [本機子行程與 Node worker 範例](../../samples/remote-worker/README.zh-TW.md)
- [JWT runner 與 SSH 範例](../../samples/remote-runner/README.zh-TW.md)

這個工作區套件仍為 private。獨立行程不等於權限沙箱。

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
