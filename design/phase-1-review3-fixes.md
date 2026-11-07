# 阶段 1 第三轮审查修复

基线为
`ba779a7`。完整阅读 astra-review3.md 后，三个复现均迁入永久测试，`review-phase1-probes.test.ts`
已删除。修复按 F1、F2、F3 顺序分别提交；随后对阶段 1 的所有权与当前事实路径作独立反向检查。

## Finding 与证明

| Finding  | 提交      | 一句话根因                                                                                                                                                                                             |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1       | `1a86f19` | Restart 释放旧代的 scoped policy binding 后，恢复先读授权、后重建 binding，真实 Policy 因而返回 UnknownArtifact；恢复元数据改由新分配 scope 持有，先建立 binding，再取新授权前提，并在执行前复查批准。 |
| F2       | `b800638` | 等待分配超时被当成分配执行已结束，提前记录 NotStarted 并清理资源、结算代与容量；准备和分配共用 OwnedExecution，等待原始 fiber Exit，协调器超出 terminate 等待即 Stuck，迟到观察者结算原所有权。        |
| F3       | `3e701f6` | 当前版本来自逻辑实例 tombstone，路由却永久捕获旧注册；改从当前实例索引读取注册，同时校验 installed registration 与实际 attempt 身份，旧结局快照和结算租约仍独立。                                      |
| 自检补充 | `ebc768e` | 分配结束后的不可中断生命周期操作或 terminate 命令仍可能使用宿主资源，Unit 退出却触发提前清理；资源使用者归同一 FiberSet，关闭工作准入并等待原始 fiber 结束后才清理。                                   |

| Finding      | 永久文件                                          | 测试名                                                                                           |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F1           | plugin-remote/test/change-recovery-policy.test.ts | recovers an approved artifact after Restart releases its previous policy binding                 |
| F1           | 同上                                              | rechecks real policy approval before executing a freshly bound recovery                          |
| F2           | core/test/change-allocation.test.ts               | timed-out allocation retains resources and reservations until its original executor exits        |
| F2           | 同上                                              | cancelled allocation keeps capacity and resources until its original executor exits              |
| F2           | 同上                                              | retains the full late allocation failure without rewriting its Stuck outcome                     |
| F2           | 同上                                              | keeps an unconfirmed recovery allocation Stuck until its actual executor exits                   |
| F3           | core/test/change-settlement.test.ts               | current member facts follow the indexed registration after instance recreation                   |
| 自检补充     | core/test/change-execution-lifetime.test.ts       | retains host resources until an uninterruptible startup operation exits after unit termination   |
| 自检补充     | 同上                                              | retains host resources until an uninterruptible termination command exits after unit termination |
| 自检回归修正 | core/test/transition.test.ts                      | fences late readiness until settlement and ignores stale failure after a later change            |

以上路径均在 packages/ 下。F1 使用生产 Policy.install/bind/review/approve/revoke，只有 Unit 生命周期受测试控制，没有独立模拟授权比较。第二条在恢复分配期间真实撤销批准，断言恢复的 Unit.start 没有执行。

F2 覆盖正向 deadline、调用方显式取消、迟到 defect 与恢复分配；检查等待有界、执行前资源未清理、容量仍被占用、冲突请求 Busy、迟到清理后释放所有权，以及同一 handle 的原始 Stuck 对象不变。准备侧既有 shutdown/迟到失败测试继续驱动同一原语。取消的 race 可以忽略败方清理返回的错误，因此结局另从仍被拥有的分配租约读取未确认义务，不仅判断返回的错误标签。

F3 依次验证旧注册退出、同名实例重建、重建后的再次变更和再次退出：当前版本、代、健康与 matchesTarget 跟随当前注册；早先的 outcome 不变。

## 反向检查与惯用法

检查了 preparation 的所有未准入退出、allocation 的正向/取消/恢复/initial
registration 路径、生命周期操作及命令、宿主 close/dispose、late
settlement、注册关闭与重建、代租约与容量结算、Change 发布/归档、facade 调用 credit，以及 Remote
driver 的 binding/退出记录和 release 的补偿入口。

找到并修复上表的宿主操作寿命问题：Unit
exit 是运行时 lease/capacity 的结算证据，不是宿主资源使用者全部结束的证据。OwnedExecution 的 FiberSet 和原始 fiber
await 约束宿主资源清理；原 AsyncClose 仍是唯一 close 执行者，原始 Exit 与 Release.close 的中断归因语义保留。等待 host
release 自身不加入它正在关闭的资源使用者集合，避免自等待。

旧 late-readiness 测试曾要求不可中断 readiness 仍未结束时立即 Aborted 并允许新 Change，这与候选结算要求冲突。现在测试先取得 Stuck、验证 Busy，释放 readiness 并等待真实结算后才提交后续 Change，再验证旧失败无法改变新路由。

分配租约没有 Attempt 时，迟到观察者现在也必须等待原始 allocation
executor；不再直接伪造 NotStarted。settlement 仍按原 managed/token/id 处理；当前逻辑成员事实通过当前索引读取，releaseRegistration 继续以注册对象身份检查，term 高水位不随重建重置。没有发现需要额外改变的注册事实路径。

内联类型导入整理提交为
`f3eafea`；受影响 core/release/remote 共 142 个文件、1,326 项通过，1 项跳过，typecheck 通过。整理覆盖阶段 1 实际修改的生产文件，保留真实动态 import。未重写无关引擎；新提取的 beginAllocation、finishAllocation、unconfirmedAllocations、currentRoute 与 OwnedExecution 围绕明确的所有权或事实边界。

## 规格解释

A 为 design/architecture.md，P 为 design/phase-1.md；本轮不修改规格。

| 决定                                                                                                         | 来源                                                             |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 恢复先重新取得 scoped binding，再捕获当前授权；在 Unit.start 前复查批准，保留对象/version 预留检查。         | A:409–410；P:205–206、253–260                                    |
| 分配 fiber 仍可能执行时，deadline 不构成 NotStarted 或容量释放证据；等待结束可报告 Stuck。                   | A:214、218–220、370；P:76–80、151–160、192–197、226–227、264–277 |
| 原始 Unit exit 允许结算该代的运行时租约与容量，但宿主清理继续等待其资源使用者真实退出，且保留原始清理 Exit。 | A:214、219–220；P:76–80、195–197                                 |
| 当前成员事实跟随逻辑实例的当前注册；记录的 outcome 以及原注册的迟到结算义务不随重建迁移。                    | A:397–402、422；P:82–94、155–160、222–227                        |

不可中断的宿主执行器若永不退出，协调器仍可有界返回 Stuck，资源和相应所有权继续保留；整个运行时关闭可能等待真实执行结束。A:370 不允许把协调器 deadline 当作执行结束证据。本轮没有承诺终止任意宿主 TS 代码。

没有把完整跨单元完成、成员闭包、supervisor 或持久化证明加入阶段 1。没有绕过 design/upstream 中两个 Effect 缺口。未直接执行 scripts/packed-*.mjs；仅最终 pnpm
build 既有检查可间接执行其构建检查。

## 失败与中断记录

本地日志为 .cache/review3-*.log；下面包含预期红测试及开发中失败，不能读成最终批次全部通过。

| 检查                   | 结果与修正                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编排工具               | 一次 JavaScript 编排表达式语法错误，未启动其包含的命令；修正后重跑。                                                                                                         |
| 初次读取技能           | 一次 devenv GC root 不存在，入口退出 1；串行重读成功。一次不存在的 remote/test/change.test.ts 路径和一次未匹配的文档 glob 读取失败；改用 rg 定位。                           |
| F1 永久红测试          | 真实 Policy 返回 UnknownArtifact，实际 RecoveryFailed、期望 Recovered。                                                                                                      |
| F1 扩展测试 typecheck  | revoke 的 PolicyError 未映射到 DriverError，另有 yield-in-call-argument；补齐错误映射并取显式结果变量。                                                                      |
| F2 永久红测试          | 实际 Aborted，期望 Stuck；原 scope 在 allocation 未结束时已清理。                                                                                                            |
| F2 初次 typecheck      | Evidence 可选字段显式 undefined 不合法、测试误用 HashSet.size 属性；改为 Option 分支与 HashSet.size 函数。                                                                   |
| F2 扩展断言            | 两次租约数断言分别忽略旧路由尚未清除和旧代已被迟到观察者正常退役；明确清除失败路由，并断言实际被保留的 allocation id。                                                       |
| F2 取消扩展            | test timeout 与 hook timeout；发现 race 败方清理错误不决定最终失败标签，改为独立读取未确认分配义务。                                                                         |
| F2 拒绝断言            | 三项把 Busy 当成 Cause.pretty 的文字输出而失败；改检查 typed rejection.reason。                                                                                              |
| F2 恢复扩展            | 最初沿 Overlap 在旧代健康时正确 Aborted，等待 term 3 超时；改为真实 Restart 恢复路径后通过。                                                                                 |
| F3 永久红测试          | 同名重建后实际 Unavailable、期望 Serving。                                                                                                                                   |
| F3 初次 typecheck      | 两处 yield-in-call-argument；提取 currentRoute 并使用显式中间值。                                                                                                            |
| 自检测试初稿           | 多一个右括号造成 parser/typecheck/Vitest 与自动 treefmt 入口失败。修正语法后，撤回仅两份尚未提交的自检实现草稿，重新在已提交基线上取得实际红测试，再实现修复；没有改写提交。 |
| 自检实际红测试         | startup 尚未结束时 before 已包含 cleanup；真实复现提前清理。                                                                                                                 |
| 自检完整 core 中间批次 | 896 通过、1 失败：旧 late-readiness 测试等待过去不真实的 Aborted，test/hook timeout；按上文的结算语义迁移。                                                                  |

没有主动终止或中断任何检查。全部红测试和开发失败均在修正后重跑；最终根测试的已知 benchmarks 例外另列。

## 最终检查

| 检查                                 | 真实结果                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 每步 typecheck                       | 均在相应修正后通过；开发中的失败见上表。                                                          |
| F1 core + remote                     | 135 个文件、1,293 项通过，1 项跳过。                                                              |
| F2 core                              | 85 个文件、894 项通过。                                                                           |
| F3 core                              | 85 个文件、895 项通过。                                                                           |
| 自检补充 core                        | 86 个文件、897 项通过。                                                                           |
| 类型导入整理 core + release + remote | 142 个文件、1,326 项通过，1 项跳过。                                                              |
| 最终 pnpm typecheck                  | 通过，退出 0。                                                                                    |
| 最终 pnpm build                      | 通过，退出 0；TypeScript 7 验证 92 个公开入口，构建 2,662 页并验证站内链接。                      |
| 最终 pnpm test                       | 327 个文件通过、2 个 benchmarks 文件失败；2,427 项通过、46 项跳过、2 项失败，仅为指定的已知例外。 |
| 最终 docs package test               | 通过，退出 0；Node/TypeDoc 25 项，Vitest 21 个文件、41 项。                                       |
| treefmt --no-cache                   | 通过；无缓存扫描仅纠正 F1 测试的一处换行，已核对无语义变化；提交后再次确认无 diff。               |

最终根测试的两个失败均按指示保留，不记为通过：

- benchmarks/test/remote.test.ts：checks identical work, lifecycle counts and
  native exits for every
  connection。macOS 无法使用 /proc/self/fd/.../runner.sock。
- benchmarks/test/runner.test.ts：resolves compressed sample files relative to
  nested result outputs。macOS 不存在 /proc 进程目录。

本轮没有其他未完成的代码修复或新的真实阻塞；完整 packed 运行时证明由负责人执行。
