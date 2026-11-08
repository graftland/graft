---
title: 绑定
description: 通过编码的一元契约连接固定单元实例。
---

**绑定**为消费方的服务选择一个提供方。在 `Kernel.layer`
中声明固定绑定。编解码器和处理函数在单元内运行；内核只接收声明和路由数据。

## 声明绑定

```ts
import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Units from "@graftland/plugin-remote/Units"

declare const provider: Kernel.Target
declare const consumer: Kernel.Target
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances: [
		{ id: "forecasts", target: provider },
		{ id: "gateway", target: consumer },
	],
	bindings: [
		{ consumer: "gateway", provider: "forecasts", service: "app/Weather" },
	],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
```

## 匹配契约

| Rule   | Requirement                                                                           |
| ------ | ------------------------------------------------------------------------------------- |
| 提供方 | 同一提供方必须覆盖全部所需操作，不合并多个提供方的部分操作。                          |
| 标识   | 所需的不可变 `name@version` 标识必须是提供方声明的子集。                              |
| 来源   | 两个目标使用同一份已捕获的 `contractArtifact`。同一标识的来源或线路标签不同会被拒绝。 |
| 形态   | 只支持一元操作。重复操作标识和服务键在 Describe 阶段失败。                            |

## 安装视图

提供方升级先在每个运行中的消费方安装受影响的路由，再激活。缺失或过期的确认不能激活视图。安装失败会丢弃暂存视图；缺失参与方的退出证据仍是未解决的义务。

提供方处理函数使用提供方自己的 Context 和 Scope。通道编码载荷、类型化错误和结果。只有
`traceparent`、`tracestate`
及 Graft 来源、能力与票据元数据跨越边界；任意调用方标头和 Context 服务不会传递。
