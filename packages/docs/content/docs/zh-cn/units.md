---
title: 执行单元
description: 在原生执行边界之外运行内核实例。
---

**执行单元**是内核之外的原生执行边界。Worker 提供故障边界。不受信任的工作应使用沙箱化的 Process 单元（见[信任策略](../trust/#执行边界)）。

## 选择捕获的代码

用 `Artifact.capture`
捕获已构建的 JavaScript，再指定可选的契约导出和编码配置。插件与契约导入、配置解码都在执行单元内运行。

```ts
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Units from "@graftland/plugin-remote/Units"

declare const artifact: Artifact.Artifact
const target = Units.target({
	artifact,
	contract: "contract.js",
	input: { region: "north" },
	placement: "Worker",
})
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 3,
	instances: [{ id: "forecasts", target }],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
export const inspect = Effect.flatMap(Kernel.Kernel, (kernel) =>
	kernel.inspect({ instance: "forecasts", target }),
)
```

没有编码端点的插件可以省略
`contract`。检查解码插件自己的配置 Schema，不激活插件，也不构造虚假的契约。这种目标使用 Restart。

## 准入前检查

`kernel.inspect`
验证目标，但不激活插件。提交也可以启动检查。两种方式都将检查及其退出计入总预算。

| 事实 | 规则                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 容量 | 检查占用一个执行单元槽位；满容量时，未缓存的检查可能失败。                                |
| 复用 | 已验证声明要求相同的制品、配置和验证环境；授权始终重新检查。                              |
| 拒绝 | `ChangeRejected.preparation` 标识保留的检查证据，不创建 Change id。                       |
| 观察 | `getPreparation`、`preparations`、`inspections` 和 `units` 显示剩余工作及准确的退出证据。 |
| 等待 | 中断提交等待者不会取消运行时拥有的检查。                                                  |

## 单元环境

每个单元构建自己的 Node 服务、HTTP 客户端、时钟和日志器。自定义环境与 intercept 模块导出 Layer，通过
`Configuration.Options`
接收 JSON 选项。有序配置构建新的 Layer；恢复时重新构建，并按当前策略重新解析原始引用。

| 准备方式 | 行为                                                     |
| -------- | -------------------------------------------------------- |
| 模块解析 | 在可丢弃单元中检查导出形式，不解码插件输入或调用 apply。 |
| 部署检查 | 构建环境模块、解码配置，不调用 apply 或获取服务资源。    |
| 执行     | 重新构建环境，并重新核对检查过的声明。                   |
| 截止时间 | 终止单元并要求原生退出证据；缺失证据仍保留未结工作。     |

通过 [Loader 准备](../loader-api/)
登记不可变的 intercept 模块。函数、Schema、Context 和 Layer 不会出现在部署数据中。

## 选择部署位置

| 部署位置  | 执行所有者                                                           |
| --------- | -------------------------------------------------------------------- |
| `Worker`  | 内核部署服务观察准确的 Worker 退出。                                 |
| `Process` | 内核部署服务观察准确的子进程退出。                                   |
| `Runner`  | `Units.serveRunner` 拥有子进程并报告准确的执行身份；仅支持 Restart。 |

Runner 地址包含本地控制套接字和所有者身份。断连不能证明退出。缺少退出证据时，容量和所有权继续保留。

控制连接正常关闭是调试事件。无效或不完整的帧仍是错误。连接关闭和帧错误都不能证明执行单元已退出。

### 模块格式

| 模块                                               | `Worker`                           | `Process`                                    |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| ES 模块                                            | 支持                               | 支持                                         |
| CommonJS（`.cjs`，或没有 `"type": "module"` 的包） | 支持                               | 支持                                         |
| 原生扩展（`.node`）                                | 仅当该扩展支持同一进程内多个实例时 | 支持；每个单元加载自己的副本。尚无测试覆盖。 |

每次重载都会启动新的单元，因此模块的代码、缓存和原生扩展都是重新加载的，上一代的内容不会留在内存中。

## 监督

没有 Change 负责的故障归**监督者**处理。它在有界的**重启强度**内重启，超过后停止重试，并保持故障可观察。上限写在部署数据里：`supervision: { intensity: 3, period: 60000 }`（默认值）表示每个实例每 60 秒最多尝试三次。

| 事件                         | 监督者的处理                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 成员失败                     | 在其单元内重启它及其本地消费者；健康的同组成员继续服务。                                 |
| 单元自行退出                 | 先对整组结算，再提交一个部署该组期望目标的 Change。                                      |
| 重启强度耗尽                 | 升级该实例：它保持失败状态，其他实例不会被重启。针对它的 Change 被接受后，升级状态解除。 |
| 成员由某个 Change 负责       | 由该 Change 失败或恢复；监督者不另起竞争的尝试。                                         |
| 重启与正在执行的 Change 冲突 | 等待，在该 Change 释放对象后再次尝试。                                                   |

尝试次数按实例计算，不因新的一代而清零；`Busy`、计划内的换代和内核关闭都不计数。`kernel.supervision`
与 [`client.supervision`](../control/) 列出最近的尝试和升级状态。

## 读取执行任期

`Plugin.term`
在服务执行单元内提供内核授予的任期。每次尝试都消耗新任期，包括失败的启动。检查和普通嵌入式调用者收到
`UnitOnly`。任期仅在本内核运行期间保留；跨内核重启的 fencing 需要外部持久协调。
