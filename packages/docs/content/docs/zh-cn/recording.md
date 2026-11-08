---
title: 记录
description: 要求变更在执行、提交和成功之前，先取得已确认的记录。
---

**记录者**是执行单元里持有部署记录角色的插件。变更涉及记录范围内的实例时，内核在每个阶段向记录者发送一条记录，并等待它确认。

- 意图记录确认之前，不执行任何生命周期操作。
- 提交决定确认之前，不激活任何路由。
- 结论记录确认之后，才报告 `Accepted`。
- 停止、终止和退出观察从不等待记录者。

## 声明角色

记录是部署数据。闭包里包含 `scope` 中实例的每个变更都要记录，请求不能选择跳过。

```ts
import { Layer } from "effect"

import { Kernel } from "@graftland/graft"
import { Units } from "@graftland/plugin-remote"

declare const instances: Kernel.Deployment["instances"]

export const kernel = Kernel.layer({
	authority: "shop",
	maxUnits: 8,
	instances,
	recording: { recorder: "release", instance: "release", scope: ["checkout"] },
}).pipe(Layer.provide(Units.layer))
```

| 字段         | 含义                                                      |
| ------------ | --------------------------------------------------------- |
| `recorder`   | 插件注册时使用的角色名。                                  |
| `instance`   | 唯一可以持有该角色的实例，角色由它所在的单元持有。        |
| `scope`      | 需要记录的变更所涉及的实例。                              |
| `maxRecords` | 未确认与已预留记录的上限，超出的新工作会被拒绝。默认 64。 |

## 从配置文件启动

在配置文件中声明记录者，然后运行 `graft start --watch`：

```yaml title="graft.yml"
- id: release
  name: "@graftland/plugin-release/Recorder"
  recording: { role: release }
  config:
    recorder: release
    directory: ./.graft/journal

- id: checkout
  name: ./plugins/checkout.mjs
```

| 设置              | 规则                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `recording.role`  | 此条目持有的角色，须与插件注册的角色一致。任何实现记录协议的插件都可以持有。                                                 |
| `recording.scope` | 需要记录变更的条目 id。省略时包含其他所有应用条目，包括嵌套和禁用的条目；空列表表示不记录。                                  |
| 角色持有者        | 仅一个启用的应用条目可以声明角色，不能用于分组。记录者先单独启动，再启动需要记录的条目。                                     |
| 后续编辑          | 相同声明可以重复提交。更改或移除角色、持有者或范围需要重启应用；监听模式报告 `RecordingConflict`。增删条目也会改变默认范围。 |

## 运行记录者

`@graftland/plugin-release/Recorder` 是一个普通的记录者。把它部署为
`instance`，输入为
`{ recorder: "release", directory: "./journal" }`：它把每条记录追加到该目录的日志中，同步到磁盘后才确认。不设
`directory` 时，记录只保存在所在单元的内存里。第三方插件通过同一个
`Recording.Recorder` 服务持有该角色，第一方没有特殊通道。

```ts
import { Effect, Stream } from "effect"

import { Plugin } from "@graftland/graft"
import { Recording } from "@graftland/plugin-remote"

export default Plugin.make({
	name: "audit-recorder",
	inject: [Recording.Recorder],
	apply: Effect.fn(function* () {
		const recorder = yield* Recording.Recorder
		yield* recorder.records.pipe(
			Stream.runForEach((record) => recorder.acknowledge(record)),
			Effect.forkScoped,
		)
		yield* recorder.register("release")
	}),
})
```

| 规则     | 行为                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 身份     | 单元的控制通道标明化身，插件不能替其他化身注册或确认。                    |
| 注册     | 接受来自承载 `instance` 的单元的注册；该单元成为当前单元后授权才生效。    |
| 确认     | 存储之后再确认。重复确认会被忽略；内容、所有者或化身不符则被拒绝。        |
| 重新连接 | 同一化身再次注册时，内核重发它尚未确认的记录。                            |
| 持久性   | 设置 `directory` 时写入磁盘上的日志，否则没有。内核保留记录直到它被确认。 |

## 读取日志

日志由分段组成，每条记录一行；并发的变更交错写入。`@graftland/plugin-release` 的
`Journal.history(directory)`
无需运行中的内核即可读取，按内核运行与变更 id 各返回一份摘要：阶段、成员、目标、结局、`concluded`，以及最新一条记录中每个成员的期望与实际目标、健康状态、本次尝试的情况（`NotStarted`、`Started`、`Ready`、`Failed`、`Stopped`）、阶段和诊断引用。诊断仍在保留期内时，摘要也包含渲染后的 cause（至多 4096 个字符）。

| 情形               | 结果                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| 同一条记录再次送达 | 不写第二行即确认。同一 id 但内容不同则被拒绝。                                 |
| 写入或同步失败     | 不确认；下一次追加先截掉残留的半行，单元运行期间每秒重试，因此该变更保持受阻。 |
| 进程在写入中途停止 | 记录者打开日志时删除被截断的最后一行；更早的损坏行会使日志拒绝打开。           |
| 进程在变更中途停止 | 该变更只有意图而没有结论：`concluded` 为 `false`；成员事实显示已经运行了什么。 |
| 内核重启           | 变更 id 从 `change-1` 重新开始；运行 id 把两次运行区分开。                     |

## 内核重启后恢复

设置 `directory`
时，记录者在向新内核注册前读取日志。日志行保留每个请求的键和规范化请求文本。

| 已记录的状态                 | 重启后                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 带键的意图，无论是否已有结论 | 相同键和规范化请求以 `AlreadyRecorded` 拒绝；`conflicts` 指出之前的 `"<run>/<change>"`。相同键下的不同请求以 `KeyConflict` 拒绝，不再次执行工作。 |
| 有意图但没有结论             | 内核按原运行与变更 id 补记结论。历史显示 `concluded: true`、没有结局、阶段为 `Interrupted`，并附上成员当前的事实。未知的目标仍然未知。            |
| 已压缩分段中的记录           | 恢复时保留其请求键和未完成变更的信息。                                                                                                            |
| 内存记录者                   | 内核重启后，请求键和记录不保留。                                                                                                                  |

`Interrupted`
结论不宣称先前工作成功或失败，也不继续或撤销先前动作。诊断过期不会删除请求键或持久的成员事实。

## 保留诊断

**诊断引用**是不透明的标识符，指向 `directory/diagnostics`
中渲染后的 cause；较长的 cause 内核只发送前 4096 个字符，完整的 cause 在内核运行期间可按 Change
id 查询。日志行只保存引用和到期时间，不包含 cause。诊断文件可能含有秘密，应像其他敏感应用数据一样限制该目录的访问权限。

| 设置或字段            | 行为                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `diagnosticRetention` | 记录者输入，例如 `"7 days"`；必须是有限的非负时长。默认 `"30 days"`。                        |
| 保留期起点            | 首次存储诊断时。修改设置只影响新诊断。                                                       |
| `diagnosticReference` | 历史摘要中的引用及到期时间；没有 cause 时为 `None`。                                         |
| `diagnosticStatus`    | `None`、`Available` 或 `Expired`。过期摘要显示 `Diagnostic expired`；结局和引用仍然保留。    |
| 过期文件              | 记录者打开日志、追加之前和每小时维护时删除。记录者停止时，历史读取会报告过期，但不删除文件。 |
| 写入或同步失败        | 诊断和日志条目都存储并同步之后才确认记录。                                                   |

## 压缩分段

记录者在启动和每小时维护时压缩符合条件的分段。通过 `Journal.open`
打开的日志也提供 `compact` 和 `prune` effect，供显式维护。

| 规则     | 行为                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 条件     | 连续的已关闭分段，其中每个变更都有结论记录时，可以合并。含有未完成变更的分段和当前打开的分段保持原样。 |
| 历史     | 压缩保留每条记录、顺序、诊断引用及 `Journal.history` 结果。减少的是分段文件，不是保留的结局记录。      |
| 压缩中断 | 重新打开时读取完整的旧分段或替换分段集合，不重复记录。后续维护会删除被替代的文件。                     |
| 所有权   | 一个目录由一个记录者持有。显式维护应通过其日志句柄执行，不要为同一目录打开另一个写入者。               |

## 缺少记录时

| 情形                       | 结果                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| 提交时没有存活的记录者     | 在分配变更 id 之前以 `RecordingUnavailable` 拒绝。                    |
| 未确认的记录过多           | 以 `RecordingCapacity` 拒绝，不会淘汰任何记录义务。                   |
| 记录者不再确认或已退出     | 后续工作等待；预算照常耗尽，按通常的[结局规则](../transitions/)收尾。 |
| 只缺结论记录               | 执行已经完成并保持原样。不报告结局；取消也不改变任何东西。            |
| 记录者带着未确认的义务退出 | 新的化身不能确认这些义务，`status.recording.blocked` 保持为 `true`。  |
| 变更会替换记录者所在的单元 | 若该变更需要记录，或存在未确认的义务，以 `SelfReplacement` 拒绝。     |

`status.recording`
显示当前关卡、未确认的记录以及它们是否受阻。`kernel.recording` 和
[`client.recording`](../control/)
列出所有未确认的记录，包括已退出记录者的记录。内核进程丢失时，未确认记录的投递队列随之丢失；持久日志仍可用于恢复。
