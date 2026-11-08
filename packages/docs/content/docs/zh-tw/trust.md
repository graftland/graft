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

Worker 和 Process 隔離執行，不限制權限。需要權限邊界時，把 Runner 擁有者放在操作者控制的容器或虛擬機中。控制能力憑證和製品儲存須可信。原生退出證明執行已結束，不證明終結器成功。
