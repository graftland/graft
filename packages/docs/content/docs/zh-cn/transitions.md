---
title: 变更
description: 提交、等待和观察内核变更。
---

**变更**对内核实例执行 `Deploy` 与 `Remove`
操作。内核规划它们的部署组，并负责试运行、恢复和收尾。嵌入式 `Graft.plugin`
组合提供协作式生命周期，不安装内核服务。

## 提交与等待

内核层与嵌入式运行时分别构建。请求只包含部署数据，不能传入闭包或 Context。中断等待的 fiber 不会取消变更；使用
`handle.cancel` 请求取消。

```ts
import { Effect } from "effect"

import { Change } from "@graftland/graft"

declare const target: Change.Target
export const upgrade = Effect.gen(function* () {
	const handle = yield* Change.submit({
		key: "forecasts-v2",
		operations: [{ _tag: "Deploy", instance: "forecasts", target }],
	})
	const conclusion = yield* handle.await
	const current = yield* Change.get(handle.id)
	return { conclusion, current }
})
```

## 请求字段

| 字段                  | 含义                                                                                                                                                                              | 默认值                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `operations`          | `Deploy`（实例、目标，可选的领域、同驻与放置）和 `Remove`。                                                                                                                       | 必填                                    |
| `key`                 | 请求键：相同的键与相同的请求返回同一个 Change。                                                                                                                                   | 无                                      |
| `strategy`            | `Restart` 先停旧代再启动新代；`Overlap` 在切换期间新旧并行服务。runner 只接受 `Restart`。                                                                                         | `Restart`                               |
| `budget`              | `total`、`startup`、`probe`、`drain`、`stop` 与 `terminate` 的毫秒数。                                                                                                            | 总计 300 000，启动 30 000，其余各 5 000 |
| `requirements.probes` | 除插件声明的探针外，新代开始服务前还必须通过的[探针](../probes/)。失败时 Change 中止或恢复。                                                                                      | 无                                      |
| `requirements.trial`  | 新代在 Change 结束前必须持续服务的毫秒数。                                                                                                                                        | 0                                       |
| `completion`          | `Serving`：新状态开始服务后才结束。`Committed`：期望状态通过校验并记录后即结束；之后内核在自己的 Change 中启动成员，该 Change 的 `origin` 指向本次。`Remove` 操作需要 `Serving`。 | `Serving`                               |

## 观察

`Change.get` 返回当前事实。`Change.changes` 发布带序号的快照。发现序号缺口时通过
`get` 对账；慢订阅者不会阻塞协调。即使无键历史记录过期，句柄仍保留不可变结局。

检查、容量和原生退出证据见[执行单元](../units/)。

## 结局

| Outcome          | Meaning                                      |
| ---------------- | -------------------------------------------- |
| `Accepted`       | 目标通过试运行，且必要的旧执行退役证据齐全。 |
| `Aborted`        | 失败后，旧代仍健康、获授权且未变。           |
| `Recovered`      | 全新独占恢复通过完整试运行。                 |
| `RecoveryFailed` | 恢复失败，且所有必要退出均已确认。           |
| `Stuck`          | 缺少必要执行证据；所有权仍可观察。           |

## 限制

预算以毫秒计，覆盖整个提交。请求键的身份在运行时生命周期内保留；相同键下的不同规范化请求被拒绝。强制退出后的未知清理不代表终结器成功。缺少退出证据时保留容量和预留。在容量允许时，无关实例可以继续。

## 嵌入式生命周期

嵌入模式的代码变更需要重启进程。嵌入式重启和原地更新不提供内核变更结局或原生终止保证。
