---
title: 执行转换
description: 观察协调器结局，并实现有作用域归属的执行驱动。
---

`Graft.transition` 协调一个受管理 fork 的执行单元替换。 **受管理 fork**
注册执行驱动，并在换代时保留契约服务对象。目前尚未提供内置 Remote 转换驱动；普通插件、Remote 插件和 runner 目标均返回
`Aborted`，原因为 `UnsupportedTarget`。

## 请求转换

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const forkId: number
declare const deployment: Remote.CandidateOptions

export const request = Graft.transition({
	fork: forkId,
	candidate: Remote.candidate(deployment),
	policy: { drain: 5_000, terminate: 5_000, probes: ["health"] },
})
```

`Remote.candidate`
构造一个惰性的候选描述，包含已捕获的工件、契约模块、直接执行目标和输入。它既不校验也不启动工件。[捕获和校验](../remote/artifacts/)
仍须显式执行。目前对 Remote fork 发起此请求会返回 `Aborted(UnsupportedTarget)`。

| 入场规则                                 | 结果                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| 已有转换在执行，包括试运行期             | `Aborted(Busy)`；请求不会排队。                                           |
| 目标没有匹配的已注册驱动                 | 分配单元前返回 `Aborted(UnsupportedTarget)`。                             |
| 截止时长不是有限正数，或试运行时长为负数 | `Aborted(InvalidPolicy)`；允许零试运行时长。                              |
| 之前的转换尚未确认单元终止               | 返回 `Aborted(Stuck)`，直到运行时被释放。迟到的退出证据不会重新开放入场。 |
| 调用者在入场后取消等待                   | fork 负责完成转换和恢复；取消等待不会取消转换。                           |

## 结局和证据

| 结局             | 含义                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `Accepted`       | 候选已服务，并已观察到旧单元退出。                                                                   |
| `Aborted`        | 入场失败，或候选在切换前失败且已确认终止。拒绝候选后保留旧路由。                                     |
| `Recovered`      | 确认候选和旧单元均已终止，再以旧工件启动新的服务尝试并就绪。也适用于拒绝候选时旧尝试已经失败的情况。 |
| `RecoveryFailed` | 恢复失败；失败单元均已确认终止，调用返回 `Unavailable`。                                             |
| `Stuck`          | 无法确认必要的终止。调用返回 `Unavailable`，后续转换被阻止。                                         |

结局附带阶段和证据，包括完整失败 cause、截止情况和观察到的退出。终止命令、传输断开或作用域关闭都不算退出证据。停止或排空超时后，只要确认终止，仍可返回
`Accepted`；这些失败会保留在证据中。

## 策略和调用

所有时长单位均为毫秒。`startup` 分别限制每次分配、启动、描述、服务和就绪操作。
`probe` 限制每个请求的探测。`trial`、`drain`、`stop` 和 `terminate`
限制各自阶段。默认启动截止为 30 秒，其他截止为 5 秒，无试运行期，也不请求探测。切换前，驱动必须声明可安全重叠运行，并提供所有所需的
`name@version`。

门面在调用的 Effect 执行时选择服务尝试，即使该 Effect 是之前构造的。选择和入场与切换保持原子性。已入场的调用固定在该尝试上。新调用进入新尝试；旧调用完成、被取消，或在排空预算耗尽、旧单元退出后结束。单元终止提供清理证据；仅收到 RPC 响应无法证明服务端请求作用域已清理。

`Fork.generations`
观察启动、服务、排空、已终止和卡住的单元代。未受管理的 fork 返回空列表。恢复会分配新的单元和服务尝试，不复用失败的尝试。

## 驱动扩展点

```ts
import { Plugin, Transition } from "@graftland/graft"

declare const driver: Transition.Driver
declare const registration: Transition.Registration

export const integration = Plugin.make({
	name: "example/integration",
	apply: () => Transition.registerDriver(driver, registration),
})
```

注册归属于当前 fork 的作用域。门面的 provision 和服务对象属于该 fork，不属于任何单元的服务作用域。
`Transition.facade`
只构造一次服务对象，并为其方法提供调用函数。协调器负责就绪、探测、切换、排空和恢复。驱动只提供生命周期操作、私有服务上下文以及可独立观察的退出，不能更改路由。

分配必须是惰性的：外部执行只能在 `Unit.start`
中开始。驱动操作必须支持安全取消；无响应的操作仍归属于 fork，直到 fork 释放。提供独立且可重复观察的
`failure` 和 `exited`。描述实现自身的操作身份，以普通插件 `apply`
作为服务主体。受管理注册暂不支持通过服务图解析的宿主依赖和插件自动重试；允许使用运行时环境服务。状态转移、通用准备、流式门面、runner 转换和多 fork 转换尚未实现。

## 绕过保护

| 路径                          | 受管理时的行为                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `Fork.update`、`Fork.restart` | 更改 fork 或其受管理后代之前，以 `ManagedFork` 失败。                           |
| `Graft.replace`               | 更改别名或配置描述之前，以 `ReplacementConflict` 失败，原因为 `ManagedFork`。   |
| Loader                        | 树中存在受管理 fork 时，在调用存储修改之前拒绝编辑、刷新和重试。                |
| HMR                           | 运行时存在受管理 fork 时，在准备重载之前返回 `Skipped`，原因为 `managed-fork`。 |

扩展工具可用 `Transition.withUnmanaged`
在外部写入期间持有绕过入场权。写入期间，驱动注册会失败。`Transition.assertUnmanaged`
只是只读预检，不会在后续工作期间持有入场权。仍可显式释放 fork。
