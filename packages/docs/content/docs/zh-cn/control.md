---
title: 公开控制接口
description: 从另一个进程提交并观察单元 Change。
---

**公开控制接口**通过本机 TCP 端点提供固定元数据。在内核作用域中启动
`Control.serve()`，把返回的地址交给客户端。地址包含连接能力凭据。

要使用独立进程，解析 `@graftland/plugin-remote/kernel`
的文件路径，以部署 JSON 路径和就绪地址 JSON 路径作为两个参数执行。部署数据遵循
`Control.Deployment`；就绪文件包含
`Control.Address`。导入可执行模块不会启动工作。

## 提交 Change

```ts
import { Effect } from "effect"

import type { Request } from "@graftland/graft/Kernel"
import { Control } from "@graftland/plugin-remote"

declare const address: Control.Address
declare const request: Request

export const replace = Effect.scoped(
	Effect.gen(function* () {
		const client = yield* Control.connect(address)
		const handle = yield* client.submit({ ...request, key: "deployment-42" })
		return yield* handle.await
	}),
)
```

调用和配置由[单元](../units/)编码；控制接口不加载业务 Schema。

## 观察

| 读取                                  | 行为                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `client.get(id)`                      | 返回带序号的当前状态；无键的已结算历史过期后返回 None。                                     |
| `client.observe(id)`                  | 先查询当前状态，再提供通知。比较序号，发现缺口后重新查询。慢观察者不会阻塞内核。            |
| `client.handle(id).await`             | 等待保留的结论。重复等待返回相同结论。                                                      |
| 断线或中断等待                        | 停止观察；已准入的 Change 继续执行。重连后按 id 查询。                                      |
| `handle.cancel`                       | 显式请求取消；结算仍需要执行证据。                                                          |
| `client.units`、`client.preparations` | 提供原生退出证据、清理分类、Cause 和剩余预留，包括准入前拒绝留下的事实。                    |
| `client.waiters`                      | 返回选择代之前有数量上限的排队调用；此时尚未分配提供方执行额度。                            |
| `client.recording`                    | 返回记录授权，以及所有未确认的[记录](../recording/)，包括已退出记录者的记录。               |
| `client.supervision`                  | 返回每个期望实例的尝试次数、升级状态和可选的未服务原因 `reason`，见[监督](../units/#监督)。 |

## 读取部署计划

状态和结论包含 `members` 映射与
`plan`。删除的实例没有期望目标，初次创建的实例没有起始目标。每个被选中的实例保留全部选择原因及其前驱。

| 计划信息 | 规则                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 本地依赖 | 在领域中解析具体提供者；本地边和显式共置决定部署组。                                                   |
| 契约依赖 | 兼容的消费者不进入替换集，除非其他原因选中它。                                                         |
| 闭包     | 反复扩展新旧部署组、本地捕获和声明的子实例。拆分或合并不会把整个闭包变成一个新组。                     |
| 放置     | 无约束的组默认使用 Worker；在生命周期操作前拒绝不兼容的显式要求。                                      |
| 预留     | 包括新旧成员关系、查询过的领域和提供者槽、可选依赖的缺失、资源，以及前向执行和恢复所需的不同单元容量。 |
| 并发操作 | 提交和恢复只应用已预留的补丁，保留无关的已接受部署。                                                   |

默认策略是 Restart。显式 Overlap 要求每个移动的实例、资源和放置方式都允许重叠。缺少提供者、存在依赖环或放置冲突的计划会在停止旧单元前被拒绝。

## 保留期限

无键的已结算历史有数量上限。有键请求和未解决事实保留到运行时结束。内核重启后不保留历史。状态中的成员、剩余预算、租约持有者和未确认单元与结果来自同一状态。
