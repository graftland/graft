---
title: 信任原則
description: 宣告成品信任及能力授權。
---

**信任原則**將成品身分與允許的能力關聯。核准屬於精確聲明；成品位元組改變時，聲明也改變。

## 安裝原則

在使用原則的嵌入式所有者中安裝，並保持其作用域存活。原則資料不會匯入外掛，也不建立核心執行邊界。

```ts
import { Effect } from "effect"

import * as Policy from "@graftland/plugin-remote/Policy"

declare const policy: Policy.Policy
export const install = Effect.gen(function* () {
	const authority = yield* Policy.install(policy)
	return yield* authority.statements
})
```

## 執行邊界

Worker 和 Process 放置隔離執行，不限制權限。執行不可信程式碼時，為它的 Process 單元啟用沙箱：

```ts
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Units from "@graftland/plugin-remote/Units"

declare const artifact: Artifact.Artifact
export const target = Units.target({
	artifact,
	contract: "plugin.js",
	input: {},
	placement: "Process",
	confinement: "Sandbox",
})
```

| 規則       | 行為                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔離方式   | Linux bubblewrap：新的 user、pid、network、IPC 與 UTS 命名空間，不保留任何 capability，清空環境變數，只能唯讀存取擷取的製品，啟用 Node 權限模型，並限制記憶體、檔案數與檔案大小。           |
| 失敗即拒絕 | 沒有 Linux、`bwrap` 或 `prlimit` 時，單元絕不以非隔離方式啟動；準備階段以 `SandboxUnavailable` 失敗。檢查（inspection）也在沙箱中執行。                                                     |
| 放置       | 只支援 `Process`。沙箱化的 `Worker` 或 `Runner` 目標以 `UnsupportedTarget` 被拒絕。                                                                                                         |
| 身分       | 沙箱屬於目標身分：核准沙箱化的目標，不等於核准同樣的程式碼以非隔離方式執行。                                                                                                                |
| 維運原則   | `setPolicy({ instance, sandbox: true, values })` 讓核心對該實例只接納沙箱化的目標，復原與監督者重新啟動也一樣。                                                                             |
| 自包含     | 沙箱中只存在擷取的製品目錄。把外掛與它的相依（包括 Effect 與 Graft）一起打包。單元用自己的 Effect 解碼設定，所以設定只用簡單結構：打包副本中的精煉（例如 `Schema.Int`）連合法的值也會拒絕。 |
| CI         | Linux 套件以 `GRAFT_REQUIRE_SANDBOX=true` 執行，命名空間不可用時失敗而不是略過。                                                                                                            |

控制能力憑證和製品儲存須可信。核心或沙箱逃逸、側通道不在範圍內。原生退出證明執行已結束，不證明終結器成功。
