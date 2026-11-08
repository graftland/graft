---
title: 应用发布
description: 规划、应用、观察和回滚不可变的应用发布。
---

`@graftland/plugin-release`
构建**发布**：包含捕获的插件与契约字节、配置和包元数据的不可变目录。工作流使用公开的[内核控制客户端](../units/)和
[Change](../transitions/)。

| 操作       | 结果                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `build`    | 内容寻址的发布 id，不激活插件                                           |
| `load`     | 验证目标并保留环境引用，供规划使用                                      |
| `plan`     | 纯计算的 Change 操作，每个成员带有 `Added`、`Changed` 或 `Removed` 原因 |
| `apply`    | 一个 Change id 及其结局、阶段和诊断                                     |
| `observe`  | 按 id 查询 Change 状态；未知时为 `None`                                 |
| `history`  | 结合日志的应用记录和结局                                                |
| `rollback` | 通过新的 Change 应用上一个已接受的发布                                  |

## 规划与应用

每个应用使用独立的发布存储目录和日志。为应用实例配置持久化的[发布记录器](../recording/)，并在应用发布前通过控制客户端授权目标。

```ts
import { Effect } from "effect"

import * as Release from "@graftland/plugin-release"
import type * as Control from "@graftland/plugin-remote/Control"

declare const client: Control.Client
declare const current: ReadonlyArray<Release.CurrentInstance>
const store = { releases: "./releases", journal: "./journal" }

const deploy = Effect.gen(function* () {
	const id = yield* Release.build(store.releases, {
		file: "./release.yml",
		references: [],
		revocations: [],
	})
	const release = yield* Release.load(store.releases, id)
	const preview = Release.plan(release, current)
	const result = yield* Release.apply(client, store, id, current)
	const status = yield* Release.observe(client, result.change)
	const releases = yield* Release.history(store)
	return { preview, result, status, releases }
})
```

| 规则     | 行为                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 当前实例 | 提供此发布工作流管理的所有实例及其当前目标，不包含记录器等基础设施。发布中不存在的实例会被移除。                       |
| 比较     | 代码、契约、放置、输入或探针变化会部署该成员。相同捕获字节的位置变化不会触发部署。                                     |
| 请求身份 | 发布 id 决定 apply 的请求键。保留首次规划和选项；重复已完成的 apply 返回原始结果，包括失败。需要再次部署时构建新发布。 |
| 引用     | `load` 保留输入中的环境引用；`apply` 只通过实例策略的引用值提供解析结果，请求、状态和历史保留引用。目标权限保持不变。  |
| 空规划   | 没有更早的应用记录且当前目标已经匹配时，`apply` 以 `ReleaseError` 的 `NoChanges` 代码失败。                            |
| 放置     | `Worker` 使用 Worker，`Local` 使用 Process 单元。不支持自定义命令和 Worker 参数。                                      |
| 旧制品   | 未捕获契约的发布必须重新构建。`metadataOnly` 只在构建时跳过包声明检查；应用时仍验证包元数据。                          |

存储目录的位置应保持稳定。捕获的包仍可能导入外部运行依赖，见[包发布](../publishing/)。

## 观察与查看历史

`observe` 返回公开的 Change 状态，包括成员事实和结论。`apply`
如实返回失败结局；判断失败的应用是否保持原状前，先检查每个成员。

| 历史字段                   | 含义                                    |
| -------------------------- | --------------------------------------- |
| `release`、`change`、`run` | 发布 id、Change id 和可选的内核运行身份 |
| `outcome`                  | 已记录或已保存的结论；未知时为 `None`   |
| `recorded`                 | 日志包含此运行与 Change 的确切结论      |
| `diagnostic`               | 日志保留的诊断；不可用时为空            |

`history`
无需运行内核，并验证引用的发布字节。将发布存储中的应用回执与日志一起保留。仅由应用客户端保存的结果为
`recorded: false`；内核的持久恢复需要记录器。即使尚未保存回执，`history`
也能从日志中的请求键恢复应用记录。内核重启后重试 `apply`
会从日志恢复原始运行身份、Change
id 和结局，不会重复执行。中断记录没有已知结局时，返回
`RecordedOutcomeUnknown`；可通过 `history`
查看事实。重复结果从日志读取诊断，回执不保留副本。取消等待不会取消已准入的 Change。

## 回滚

调用
`rollback(client, store, current)`，提供当前应用目标。它选择最近一次已接受的应用之前、与其不同的已接受发布；失败的应用不会成为回滚目标。少于两个不同的已接受发布时，以
`ReleaseError` 的 `NoPreviousRelease` 代码失败。

回滚刷新引用值，并通过正常准入提交新的 Change。它不修改目标权限，也不复用目标发布原来的 apply 结果。已撤销的目标仍以
`Unauthorized` 拒绝；发布的 `revocations`
元数据不能授予权限。返回的结局描述此次回滚尝试，包括失败或恢复。
