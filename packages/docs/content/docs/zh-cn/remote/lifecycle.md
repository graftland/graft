---
title: 替换、租约与停止
description: 安排实例替换和关闭流程时看这一页。
---

安排实例替换和关闭流程时看这一页。这里说明 generation、租约和退出确认的保证，以及宿主如何收到失败。

对于同一认证身份和 instance，runner
**确认旧进程退出后**才接纳新实例。generation 持久化并递增，runner 恢复后也成立。无法确认退出就拒绝替换。插件从
`Remote.Instance` 读取
`{ id, generation }`；外部系统可拒绝旧 generation 的写入，即 fencing，但必须自行实施检查。它不会撤销已完成的写入，不保证调用恰好一次，也不协调不同 runner。local/worker 每次都是新 id、generation
1。

宿主续租；停止续租后执行单元到期退出，runner 消失也会触发退出。整机暂停会暂停期限执行，所以不是硬实时保证；进程身份检查还有很窄的 PID 复用窗口。后代进程仍由外部 supervisor 负责。

停止先走优雅 Dispose。`shutdownTimeout` 默认五秒，只约束这一步。之后：

- 本机子进程再有一秒自然退出；超时后强制终止，spawner 再过一秒升级到 SIGKILL 并确认退出。
- worker 同样等一秒，然后 `worker.terminate()`
  并等待线程确实退出。即使终止成功，超时仍记入清理错误。
- runner 连接最多等待租约加宿主 `margin`。runner 的 `grace`
  默认五秒，是从中断到强杀的窗口；`margin` 只是宿主额外等待确认的时间。

| 结果                           | 含义                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `Exited`                       | 正常停止，确认进程退出。                                                     |
| `Killed`                       | 确认强制终止，finalizer 可能没完成。                                         |
| `RemoteTerminationUnconfirmed` | 退出未确认，可能已断连，也可能连接仍在但 runner 无法确认。超时不是退出证明。 |

前两种写入带 instance、generation 的 `remote.termination`
日志，第三种是清理错误。正常断连不记 ERROR，异常连接记带 cause 和身份的 Warning。执行寿命由 Dispose 和租约决定，不仅取决于连接。负载过高可能丢日志，宿主会报告数量。

TS 代理暴露声明的错误、`Contract.UndeclaredFailure`、`RemoteWithdrawn`、带 cause 的
`RemoteError` 和 `MissingInstance`。dispose 返回
`Fork.CleanupError`，可在其 cause 里查找
`RemoteTerminationUnconfirmed`。defect 仍是 defect。YAML 错误还会标出 entry 与失败字段。
