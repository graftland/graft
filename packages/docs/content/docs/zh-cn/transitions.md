---
title: 变更
description: 提交、等待并观察彼此独立的运行态变更。
---

**Change**
是一次已准入、具有稳定 id 的运行态替换。运行时拥有它，直到试运行、恢复和结算结束。某个 Change 等待或 Stuck 时，无关实例仍可变更。

## 提交与等待

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const candidate: Change.Candidate

export const replacement = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		instance: "forecasts",
		candidate,
		strategy: "Overlap",
		requirements: { probes: ["health"], trial: "2 seconds" },
	})
	return yield* handle.await
})
```

`Change.run` 合并提交与等待。取消等待不会取消 Change；`handle.cancel`
明确请求取消，重复调用没有额外影响。重复等待同一个句柄得到相同结局。

## 观察

`Change.get(id)` 返回当前状态；未知或已被历史淘汰的 id 返回
`None`。`Change.changes`
发送有界通知，每个 Change 带独立序号。慢观察者不会阻塞执行，遗漏通知后用 `get`
对齐。已结算观察历史保留 128 条；请求键记录和未结算记录单独保留。

## 请求键

相同请求键和规范化内容在准入检查前返回原句柄，即使版本已变化或观察历史已淘汰。相同键下的实例、候选、预期版本、策略、预算或要求发生变化时，返回
`KeyConflict`。请求键在运行时存活期间保留在内存中。

## 准入

拒绝是没有 Change id 的 `ChangeRejected` 错误。冲突请求不会排队。

| 原因                | 含义                                         |
| ------------------- | -------------------------------------------- |
| `Busy`              | 冲突对象及拥有它们的 Change id。             |
| `Closing`           | 运行时或实例已关闭准入。                     |
| `UnsupportedTarget` | 没有匹配的已注册驱动。                       |
| `InvalidBudget`     | 期限无效，或未为试运行、清理和恢复预留预算。 |
| `Stale`             | 预期实例版本已不匹配。                       |
| `KeyConflict`       | 请求键已用于不同的规范化输入。               |
| `Capacity`          | 单元容量不足以覆盖策略和恢复。               |
| `Unsupported`       | 不支持请求的策略或成员闭包。                 |

## 结局

| 结局             | 含义                                 |
| ---------------- | ------------------------------------ |
| `Accepted`       | 候选已提供服务，必要结算已完成。     |
| `Aborted`        | 旧代未停止、未被切走路由，且仍可用。 |
| `Recovered`      | 新的恢复代满足 Serving 要求。        |
| `RecoveryFailed` | 恢复未能重建服务。                   |
| `Stuck`          | 必要结算证据仍未确定。               |

结局保留 Change
id、阶段、成员和完整 cause。关闭操作如实报告可用性。Stuck 结论不会改变；迟到证据更新当前结算事实。预留只涉及受影响对象，直到结算或安全隔离后才释放。

## 预算与调用

`budget`
限制总时长以及每次启动、探针、排空、停止和终止操作。默认总预算五分钟，启动三十秒，其他操作五秒。`requirements.probes`
默认为空，`requirements.trial`
默认为零。试运行是最短观察期；前向与恢复试运行都消耗总预算。

## 策略

Overlap 要求驱动在分配前提供已验证的声明；候选先启动，旧代随后退役。缺少验证声明的驱动拒绝显式 Overlap。本实现步骤尚未提供 Restart 和暂停期间的门面调用队列。

## 启动受管理 Remote 插件

基于制品的 Remote 部署通过 `Remote.plugin`
注册驱动。Loader 绑定条目 id；嵌入使用时显式提供实例名。见[制品](../remote/artifacts/)。

## 驱动扩展点

`Transition.registerDriver`
只发布一次稳定门面。每代拥有自己的执行、解析和 lease。驱动分配不得启动执行；执行从
`Unit.start` 开始。停止确认、传输断连和 Scope 关闭都不能代替退出证据。

## 远端排空

RPC 结果和客户端取消都不证明远端请求 Scope 已完成，包括普通一元调用。通用远端请求 Scope 排空仍不支持，等待阶段 2 的完成记录。

## 绕过保护

`Fork.update`、`Fork.restart`、Loader 修改和替换操作仍通过 `ManagedFork`
拒绝修改受管理树。显式销毁仍可用。
