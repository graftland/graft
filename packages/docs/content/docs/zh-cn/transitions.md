---
title: 执行转换
description: 观察协调器结局，并实现有作用域归属的执行驱动。
---

`Graft.transition` 协调一个受管理 fork 的执行单元替换。**受管理 fork**
注册执行驱动，并在换代时保留契约服务对象。使用工件的 Remote 插件支持直接 Worker 和子进程；普通模块部署与 runner 目标返回
`Aborted(UnsupportedTarget)`。

## 启动受管理 Remote 插件

```ts
import { Schema } from "effect"

import * as Remote from "@graftland/plugin-remote"

declare const contract: Remote.Contract.Contract<typeof Schema.String>
declare const artifact: Remote.Artifact.Artifact

export const integration = Remote.plugin(contract, {
	instance: "forecasts",
	artifact,
	contractModule: "@acme/integration-contract",
	target: { _tag: "Worker" },
	maxInFlight: 16,
	policy: { probes: ["health"] },
})
```

将业务输入传给 `Graft.plugin(integration, input)`。子进程使用
`{ _tag: "Local" }`。宿主运行时提供文件系统、路径、安全随机数和子进程服务。受管理 Remote 契约支持一元操作，不支持注入宿主服务。通过服务图解析的宿主依赖与插件自动重试尚不支持。使用模块位置的
`Remote.plugin` 选项仍采用普通重启行为。

Loader 将条目 id 绑定为实例名称。嵌入式注册必须提供
`instance`；空名称、冲突或重复名称会在启动单元前失败。`target`
接受该名称或数字 fork id。名称在整个运行时中唯一。

## 请求转换

```ts
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

declare const deployment: Remote.CandidateOptions

export const request = Graft.transition({
	target: "forecasts",
	candidate: Remote.candidate(deployment),
	policy: {
		total: "5 minutes",
		drain: "5 seconds",
		terminate: "5 seconds",
		probes: ["health"],
	},
})
```

`Remote.candidate`
构造一个惰性的候选描述，包含已捕获的工件、契约模块、直接执行目标和输入。它会复制并冻结部署数据，包括嵌套 JSON 输入和目标选项，调用者后续修改不会改变保留的恢复输入。它既不校验也不启动工件。[捕获和校验](../remote/artifacts/)
仍须显式执行；驱动在每次启动单元前验证捕获内容，恢复时也会验证。

| 入场规则                                                 | 结果                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 已有转换在执行，包括试运行期                             | `Aborted(Busy)`；请求不会排队。                                           |
| 目标 fork 正在关闭                                       | 分配单元前返回 `Aborted(Closing)`。                                       |
| 目标没有匹配的已注册驱动                                 | 分配单元前返回 `Aborted(UnsupportedTarget)`。                             |
| 转换后的截止时长不是有限正数，或总预算不足以预留恢复时间 | `Aborted(InvalidPolicy)`；允许零试运行时长。                              |
| 之前的转换尚未确认单元终止                               | 返回 `Aborted(Stuck)`，直到运行时被释放。迟到的退出证据不会重新开放入场。 |
| 调用者在入场后取消等待                                   | fork 负责完成转换和恢复；取消等待不会取消转换。                           |

## 结局和证据

| 结局             | 含义                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Accepted`       | 候选已服务，并已观察到旧单元退出。                                                                                      |
| `Aborted`        | 入场失败，或候选在切换前失败且已确认终止。拒绝候选后保留旧路由；释放取消返回 `Aborted(Closing)` 并关闭路由。            |
| `Recovered`      | 确认候选和旧单元均已终止，再以旧工件启动新的服务尝试并就绪。也适用于拒绝候选时旧尝试已经失败的情况。                    |
| `RecoveryFailed` | 恢复失败，或内部协调器缺陷以 `CoordinatorDefect` 原因结束转换；所有需要清理的单元均已确认终止。调用返回 `Unavailable`。 |
| `Stuck`          | 无法确认必要的终止。调用返回 `Unavailable`，后续转换被阻止。                                                            |

`Transition.Outcome` 提供带标签的构造器和
`$match`。结局附带阶段和证据，包括完整失败 cause、截止情况和观察到的退出。终止命令、传输断开或作用域关闭都不算退出证据。停止或排空超时后，只要确认终止，仍可返回
`Accepted`；这些失败会保留在证据中。

直接单元证据区分 `Exited` 和
`NotStarted`：后者证明启动已被阻止或已结束，且从未生成执行单元。传输断开或终止命令得到响应都不能代替退出证据。

释放会先关闭入场，再取消已入场的转换。结局保留被中断的阶段、尝试和已有证据。确认清理后返回
`Aborted(Closing)`；只有缺少必要退出证据才返回
`Stuck`。协调器缺陷保留 cause，不会被归类为终止失败。确认执行单元退出不会掩盖宿主清理失败：`Fork.dispose`
将它们合并到 `CleanupError`。

## 策略和调用

策略时长接受 `Duration.Input`，例如 `"5 seconds"`、`Duration.seconds(5)`
或毫秒数。转换后的截止时长须为有限正数；试运行可为零。

| 字段                         | 限制                                       | 默认值  |
| ---------------------------- | ------------------------------------------ | ------- |
| `total`                      | 整个转换，包括终止和恢复                   | 5 分钟  |
| `startup`                    | 每次分配、启动、描述、服务和就绪操作       | 30 秒   |
| `probe`                      | 每个请求的探测                             | 5 秒    |
| `trial`                      | 切换后观察候选                             | 零      |
| `drain`、`stop`、`terminate` | 调用、正常停止，以及每次退出或宿主释放等待 | 各 5 秒 |
| `probes`                     | 切换前和恢复期间请求的探测名称             | 空      |

每个阶段的等待都受剩余总预算限制。准备和试运行预留
`5 × startup + probes.length × probe + drain + stop + 6 × terminate`
给清理和恢复。清理保留 `5 × startup + probes.length × probe + 2 × terminate`
的恢复预算。恢复在成功或需要清理之前保留两次终止等待。总预算必须大于初始预留，否则入场返回
`Aborted(InvalidPolicy)`。切换前，驱动须声明可安全重叠运行，并提供所有所需的
`name@version`。

门面在调用的 Effect 执行时选择服务尝试，即使该 Effect 是之前构造的。选择和入场与切换保持原子性。已入场的调用固定在该尝试上。新调用进入新尝试；旧调用完成、被取消，或在排空预算耗尽、旧单元退出后结束。单元终止提供清理证据；仅收到 RPC 响应无法证明服务端请求作用域已清理。

`maxInFlight`
限制每个尝试的已入场调用数。核心注册默认为 256；Remote 默认为 16，接受 1–16。超额调用在入场前以
`AdmissionRejected` 拒绝，不排队。Remote 通过 `RpcClientError`
报告协调器调用失败，原始错误保留在 reason 的 cause 中。取消调用会释放入场名额。

`Fork.generations`
观察启动、服务、排空、已终止和卡住的单元代。保留活动和卡住的单元代，以及最近 32 个已终止摘要；摘要包含候选身份，不含部署载荷。未受管理的 fork 返回空列表。`Fork.generationEvents`
向当前订阅者发布包含部署数据的完整代变更，不提供重放。缓冲区保留 64 个事件；慢订阅者可能错过较早的事件。需要持久审计历史时，应在 fork 外保存事件。恢复会从固定的旧工件和输入分配新的单元和服务尝试，不复用失败的尝试。直接单元在停止后尝试正常退出；停止超时则强制终止。外部运行时依赖不会被捕获或固定版本。

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

自定义驱动必须在注册或转换入场前构造不可变候选快照，包含恢复所需的每个嵌套部署值。核心保留该快照，无法复制任意驱动资源。

分配必须是惰性的：外部执行只能在 `Unit.start`
中开始。终止已分配的单元必须阻止后续启动并报告
`NotStarted`。终止与启动竞争时，必须等待明确的生成或退出证据。驱动操作必须支持安全取消；无响应的操作仍归属于 fork，直到 fork 释放。提供独立且可重复观察的
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
