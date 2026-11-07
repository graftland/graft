---
title: 信任策略
description: 声明制品信任与能力授权。
---

**信任策略**将制品身份与允许的能力关联。批准属于精确声明；制品字节改变时，声明也改变。

## 安装策略

在使用策略的嵌入式所有者中安装，并保持其作用域存活。策略数据不会导入插件，也不建立内核执行边界。

```ts
import { Effect } from "effect"

import * as Policy from "@graftland/plugin-remote/Policy"

declare const policy: Policy.Policy
export const install = Effect.gen(function* () {
	const authority = yield* Policy.install(policy)
	return yield* authority.statements
})
```

## 执行边界

Worker 放置提供故障边界。不可信代码需要受限子进程和运维提供的沙箱启动器。缺少隔离时拒绝执行。原生退出证明执行已结束，不代表终结器成功。
