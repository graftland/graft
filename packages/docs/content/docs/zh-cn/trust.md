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

Worker 和 Process 放置隔离执行，不限制权限。运行不可信代码时，为它的 Process 单元启用沙箱：

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

| 规则       | 行为                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔离方式   | Linux bubblewrap：新的 user、pid、network、IPC 与 UTS 命名空间，不保留任何 capability，清空环境变量，只能只读访问捕获的制品，启用 Node 权限模型，并限制内存、文件数与文件大小。 |
| 失败即拒绝 | 没有 Linux、`bwrap` 或 `prlimit` 时，单元绝不以非隔离方式启动；准备阶段以 `SandboxUnavailable` 失败。检查（inspection）也在沙箱中运行。                                         |
| 放置       | 只支持 `Process`。沙箱化的 `Worker` 或 `Runner` 目标以 `UnsupportedTarget` 被拒绝。                                                                                             |
| 身份       | 沙箱属于目标身份：批准沙箱化的目标，不等于批准同样的代码以非隔离方式运行。                                                                                                      |
| 运维策略   | `setPolicy({ instance, sandbox: true, values })` 让内核对该实例只接纳沙箱化的目标，恢复与监督者重启也一样。                                                                     |
| 自包含     | 沙箱中只存在捕获的制品目录。把插件与它的依赖（包括 Effect 与 Graft）一起打包。                                                                                                  |
| CI         | Linux 套件以 `GRAFT_REQUIRE_SANDBOX=true` 运行，命名空间不可用时失败而不是跳过。                                                                                                |

控制能力凭据和制品存储须可信。内核或沙箱逃逸、侧信道不在范围内。原生退出证明执行已结束，不证明终结器成功。
