---
title: 契约工具
description: 将带注解的契约操作投影为 MCP 工具，而不改变契约。
---

**投影**通过现有的[工具目录](../contributing/)公开选定的契约操作。契约仍然是 Effect 值。

- 本地服务与受管 Remote 门面使用相同的绑定。
- 每个工具显式声明元数据和输出处理方式。
- 更新视图保留传输连接与已准入的调用。

## 声明工具

```ts
import { Context, Effect, Schema } from "effect"
import { Rpc } from "effect/rpc"

import { Plugin } from "@graftland/graft"
import * as Projection from "@graftland/plugin-mcp-server/Projection"
import { Contract } from "@graftland/plugin-remote"

class Forecast extends Context.Service<
	Forecast,
	{
		readonly get: (city: string) => Effect.Effect<string>
	}
>()("example/Forecast") {}

const Get = Contract.operation(
	"example/forecast/Get",
	1,
	Rpc.make("Get", {
		payload: { city: Schema.String },
		success: Schema.String,
	}),
).annotate(Projection.Annotation, {
	name: "forecast",
	title: "City forecast",
	description: "Read a city forecast",
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	output: "json",
})

export default Plugin.make({
	name: "forecast-tools",
	inject: [Forecast],
	apply: () =>
		Projection.offer([
			Projection.operation(Forecast, Get, (forecast, { city }) =>
				forecast.get(city),
			),
		]).pipe(Effect.asVoid),
})
```

使用契约包导出的服务键和 RPC。调用使用贡献插件注入的服务，因此受管部署通过 fork 持有的门面调用。注解可以放在契约包中，也可以放在宿主显式声明的 MCP 视图中。

| 声明                           | 规则                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `name`、`title`、`description` | 全部必填。工具名称由 1–128 个字母、数字、下划线、点或连字符组成。     |
| 四个提示                       | 全部必填；直接映射到 MCP 注解，不做推断。                             |
| `output: "json"`               | 用可移植编解码器编码成功值，将 `{ value }` 作为结构化内容和文本返回。 |
| `output: "void"`               | 丢弃成功值。                                                          |
| 服务与操作                     | 每个组合在视图中只出现一次；视图中的工具名称唯一。                    |

## 载荷与失败

输入 schema 从操作载荷的可移植编解码器生成，采用 MCP 默认的 JSON Schema
**2020-12**
方言。它只是外部客户端视图，绝不参与契约身份、来源记录或兼容性检查。运行时仍以 Effect 解码为准。

`ProjectionError`
指明服务、操作和原因。缺少身份或注解、流式操作、RPC 中间件、递归或不透明载荷，以及没有对象根的 schema，都会在发布前被拒绝。Schema 不得需要额外的解码或编码服务。这些是投影的限制，不是契约的限制；普通契约操作在 MCP 之外仍然有效。

| 结果                       | MCP 行为                                               |
| -------------------------- | ------------------------------------------------------ |
| 工具参数无效               | 返回输入无效的 `isError` 结果；不调用服务。            |
| 已声明的业务错误           | 返回带 `kind: "business"` 和可移植错误值的 `isError`。 |
| 系统失败、未声明错误或缺陷 | 返回经过清理的 `isError`，带 `kind: "system"`。        |
| 输出编码失败               | 返回经过清理的系统结果。                               |
| 取消                       | 中断受管调用并等待其清理完成。                         |
| 格式错误的协议请求         | MCP 协议错误。                                         |

日志保留完整失败 cause，并标注服务键和操作身份，包括编码失败。业务错误值会有意公开；不要在其中放置凭据。

调用方取消或贡献插件释放时，即使调用或编码器的清理也失败，取消仍然优先。日志保留完整的混合 cause，不会将其转换为业务或系统工具结果。服务端发起的取消以协议错误返回客户端。

## 发布变更后的视图

`Projection.offer` 返回控制器。只修改宿主视图时使用
`controller.update`。视图属于部署变更时，使用
`controller.updateAfter(action, bindings, accepted)`：将 `Graft.transition`
或发布 apply 作为 action，仅接受其 `Accepted`
结局。新视图在 action 开始前完成验证。Action 与后续发布归贡献插件的 scope 持有，因此取消调用方不会丢失已接受的更新。

并发的控制器 action 会在 action 开始前以 `ProjectionError`
失败，不会排队。注册与历史记录原子发布。

宿主必须提供新的带注解视图。仅改变 worker 代码或发布物，不会将新注解导入宿主。失败的 action 保留旧视图。移除贡献插件会取消其持有的工作，并先撤下工具，再向已连接的客户端发送列表变更通知。

发布会向支持通知的 MCP 会话发出 `notifications/tools/list_changed`。
`Projection.Changed` 记录修订号及变更前后的元数据，包括服务键和操作身份。
`controller.history`
保留最近 32 个修订；需要持久审计时，由应用持久化该事件。通知和记录不授予批准，也不实现重新批准。

[集成网关示例](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
使用独立的 MCP 客户端检查工具列表、调用、描述变更通知，以及已准入的 v1 调用跨越已接受的 v2 转换而无需重连。

通过 stdio 或支持通知订阅的传输发布视图变更。Effect 4.1.2 的旧版 Streamable
HTTP 适配器不提供空闲 GET 事件流（`405`）；此路径尚未实现主动发送工具列表变更通知。使用该路径的客户端仍可无需重连地列出和调用工具。上游跟踪：[Effect #10436](https://github.com/Effect-TS/effect/issues/10436)。

## 运维批准

对于受策略管理的条目，投影元数据属于精确的[批准声明](../../trust/)。发布变更后，新调用会被阻止，直到重新批准；缓存旧工具列表的客户端也不例外。列表变更通知不是批准，已接纳的调用仍使用原来的 serving
attempt。

投影验证 MCP 字段，并以 `mcp/tools`
标签发布批准数据。撤下贡献者会移除其在线工具，但保留批准事实。重新挂载相同元数据无需再次批准；发布不同元数据会在暴露变更前阻止准入。

同一服务操作的不同视图和历史元数据版本保留各自的批准事实。重新发布未变的视图，不会抹去另一个视图，也不会恢复已变元数据的批准。
