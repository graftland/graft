---
title: 一元调用
description: 分别观察执行额度、结果与取消。
---

**调用额度**将获准的一元调用固定到提供方代际。标识包含提供方与消费方的 incarnation、会话及请求 id。调用走直接的[绑定](../bindings/)通道。

## 观察调用

```ts
import { Effect } from "effect"

import { Kernel } from "@graftland/graft"

export const calls = Effect.flatMap(Kernel.Kernel, (kernel) => kernel.calls)
export const changes = Effect.map(Kernel.Kernel, (kernel) => kernel.callChanges)
```

## 完成

| Fact     | Meaning                                                                       |
| -------- | ----------------------------------------------------------------------------- |
| 结果     | 消费方报告终结 RPC 结果，不代表提供方执行结束。                               |
| 取消     | 请求中断。取消确认不释放额度。                                                |
| 完成     | Graft 用原始 Exit 关闭处理函数的 Scope，并保留完成报告直到收到确认。          |
| 原生退出 | 只结束该提供方 incarnation 的执行。消费方退出和连接断开不能证明提供方已完成。 |

在处理函数中用 `Effect.addFinalizer`
注册清理。Graft 拥有此 Scope 及其执行。结果可能先于这些清理完成。退役先排空额度再 Stop；排空超时会请求取消，随后 Stop、终止并等待精确退出证据。缺失证据时保持 Stuck。

保证限于 Graft 提供的单跳 Scope，不包含 RpcServer 内部的请求 Scope。流、延迟回复、丢弃回复的调用与嵌套跨单元完成均被拒绝。原始缺陷和无法归因的中断仍然可见。

## 设置限制

```ts
import { Kernel } from "@graftland/graft"

declare const instances: Kernel.Deployment["instances"]
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances,
	callLimits: { concurrency: 64, waiters: 64, wait: 5000 },
})
```

| Field         | Default                                                             |
| ------------- | ------------------------------------------------------------------- |
| `concurrency` | 整个内核最多 64 个已获准调用；溢出为 NotAdmitted。                  |
| `waiters`     | 整个内核最多 64 个等待 Restart 准入的调用方；溢出为 NotAdmitted。   |
| `wait`        | 准入队列最多等待 5,000 ms。超时或取消会移除等待者，不产生执行额度。 |

Restart 暂停变更的绑定。等待者在获准时选择代际，现有调用保持固定。登记分派后若丢失且没有结果，分类为 Unknown；Graft 不重试业务调用。取消、退出和完成有预留控制容量。编码数据帧上限为 1
MiB。这些限制不约束进程总内存或外部资源。
