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

Worker 放置提供故障邊界。不可信程式碼需要受限子行程及維運提供的沙箱啟動器。缺少隔離時拒絕執行。原生退出證明執行已結束，不代表終結器成功。
