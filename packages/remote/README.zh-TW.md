# @graftland/remote

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

讓 Graft 外掛在本機 Node.js 子行程或另一台機器上執行。宣告跨邊界的服務後，宿主外掛繼續使用原來的服務介面。

```ts
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

把共用的 `Contract.make(...)`
契約與實作模組分開，宿主只匯入契約。先將契約和實作編譯成 JavaScript，再用
`Graft.plugin` 或 `graft.yml` 載入入口。自行嵌入 Graft 時，為宿主執行環境提供
`NodeServices.layer`。

連線到網路 runner 時使用
`Remote.runner(...)`。在 runner 機器上預先安裝外掛套件，並準備專用 CA 簽發的憑證。使用
`graft.yml` 時，預設以儲存的項目 id 命名實例。

- [遠端外掛文件](https://graftland.github.io/graft/zh-tw/remote/)：契約、服務、設定、部署與停止行為。
- [可執行範例](../../samples/remote-worker/README.zh-TW.md)：呼叫子行程服務，並確認關閉後行程退出。

這個工作區套件維持私有。它分開執行行程，不隔離權限；需要權限邊界時，請使用虛擬機或容器。

[Graft](https://github.com/graftland/graft) 的一部分，採用
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權條款。
