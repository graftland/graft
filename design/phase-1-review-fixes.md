# 阶段 1 独立审查修复

审查范围为
`7ab56ee..65e514e`。本轮读取完整独立报告，将六个生产复现迁移为永久测试，并按 F1–F6 顺序先复现、再修复、逐项提交。原
`review-probes.test.ts` 已删除。

## 修复、根因与证明

| Finding | 提交      | 根因与修复                                                                                                                                                                         |
| ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | `7f968d6` | 排队 dispatch 已提交 calls credit，释放 finalizer 却尚未安装；现在先安装释放义务，并在同一 STM 事务记录取得的 generation，等待仍可中断。                                           |
| F2      | `72a9909` | 稳定门面只切路由，却被当作绑定写预留；改为共享读取，保留真正的依赖边、slot 版本和 absence ABA 检查，修正旧测试及 proof 原第 36 行。                                                |
| F3      | `c7b3b4f` | recovery 继续观察已经失效的 forward candidate 授权快照；恢复开始时为 previous desired target 原子取得新授权快照，继续检查相同的对象版本和预留所有权，恢复失败 cause 也保留为证据。 |
| F4      | `dcfda6a` | duplicate 分支在不可中断区无期限等待冗余 metadata 清理；清理与失败观察归 runtime scope，立即返回原 handle，晚到失败记录完整 cause。                                                |
| F5      | `6f769c1` | 注册移出索引后，runtime 的 child scope 没有关闭；记录本注册的未结算 Change，退出、lease 与迟到结算都完成后由 parent-owned fiber 关闭 scope，普通 disposal 等待该关闭。             |
| F5 补充 | `a1da3e6` | 原子注册准入失败前已分配的空 child scope 同样被保留；准入失败时关闭它，重复同名注册不累积 parent finalizer。                                                                       |
| F6      | `143c223` | 三处结算映射分歧，迟到 exit 没更新 leaseHolders；step、退出观察和迟到结算共用实际所有权到 Status 的映射，执行 lease 释放可先于 host cleanup 完成，Stuck outcome 不变。             |

### 永久测试名

| Finding | 文件                                              | 测试名                                                                                            |
| ------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| F1      | `packages/core/test/call-admission.test.ts`       | cancelling a queued call at dispatch releases its call credit                                     |
| F2      | `packages/core/test/change-leases.test.ts`        | allows a stable facade provider to change while both consumers are changing                       |
| F3      | `packages/core/test/change-authorization.test.ts` | recovers an independently authorized previous target after candidate authorization changes        |
| F3      | 同上                                              | refuses recovery when the previous target is no longer authorized                                 |
| F3      | 同上                                              | invalidates recovery when its own authorization premise changes during trial                      |
| F4      | `packages/core/test/change-preparation.test.ts`   | a concurrent duplicate returns the original handle while redundant preparation cleanup is blocked |
| F4      | 同上                                              | logs the full late failure of redundant preparation cleanup after returning the duplicate handle  |
| F5      | `packages/core/test/change-lifetime.test.ts`      | fully disposed registrations close their runtime-owned scopes                                     |
| F5      | 同上                                              | keeps a disposed registration scope until Stuck obligations settle after late exit                |
| F5 补充 | 同上                                              | releases the unadmitted registration scope when its instance name is already registered           |
| F6      | `packages/core/test/change-settlement.test.ts`    | late exit removes the old generation from current lease-holder facts                              |
| F6      | 同上                                              | publishes late lease release before blocked host cleanup finishes without rewriting Stuck         |

## Effect 惯用法

| 项目                           | 完成情况                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单所有者异步 close             | `296b129`：metadata 和 execution host 共用 `asyncClose.ts`；一个 retained Deferred 保存原始 Exit，重复 start 不重复 close，等待取消不取消原所有者；shutdown 可同步执行尚未开始的 close。`Release.close` 及上游中断归因语义未改。 |
| 时长和预算                     | `6e36ea0`：一个 millis、一个 normalize/validate 路径；注册和 Change 共用。`transitionBudgets.derive` 的具名步骤同时推导执行限制与准入预留，删除 policyOf/valid 重复实现。测试暴露并修复注册少计前向 trial 的差异。               |
| lateSettlement 局部 mutation   | `143c223`：由 awaitLateExit 返回不可变终止证据，删除两个 let。                                                                                                                                                                   |
| inline import 类型             | `6e36ea0` 与 `7f968d6`：Change.ts、Transition.ts、changeAdmission.ts、admission.ts、runtime.ts 均改为普通类型导入。                                                                                                              |
| 大 generator                   | `bd603f4`：拆出 runOperation、acquireLease、allocateUnit、failAllocation、admitRegistration、disposeRegistration，写明 Effect 输入和结果。只拆本阶段引入/修改的路径，未重写旁路引擎。                                            |
| release 补偿 Option.getOrThrow | `1613dfa`：显式处理缺少已接受观察或匹配 member 的真实内部不变量，通过 Effect.die 给出清晰错误，不同步 throw。                                                                                                                    |

未拒绝任何要求的惯用法调整，也未新增诊断关闭或类型断言。

附加测试：

- retains one original close result across concurrent starts and interrupted
  waits
- retains an interrupt-only original exit without retrying close
- can finish unstarted cleanup synchronously during owner shutdown
- uses the same two-trial budget validation for registration and Change
  admission
- reports a missing accepted member as an explicit compensation invariant defect

## 规格决定与依据

- **稳定门面是读前提。** [architecture.md](architecture.md)
  第 441 行区分兼容契约与捕获本地资源，第 449 行只在发布/撤回时冲突；[phase-1.md](phase-1.md)
  第 18–20、222–225 行说明兼容门面不进入旧代资源闭包，门面只发布一次。第 117–119 行要求把 slot 纳入集合，并没有要求它一定是写。Phase
  1 不改变门面发布或所有权，因此所有门面 binding 预留为 shared
  read；真正的发布/撤回仍使版本前提失效。
- **恢复授权属于恢复目标。**
  phase-1.md 第 205–206、253–260 行及 architecture.md 第 409 行要求 fresh
  resolution 和当前授权。恢复只换授权目标快照，不重建或放弃 Change 的对象/版本所有权；其自身授权 ABA 仍会中止恢复。
- **重复请求的 handle 不依赖冗余清理。**
  phase-1.md 第 34–36、106–111 行。原清理继续由 runtime 拥有，错误写入完整 cause 日志。
- **保留 scope 只为未结算义务。**
  phase-1.md 第 151–163 行及 architecture.md 第 214 行。新增的本注册 pending
  Change 集合避免全局扫描；关闭者在 managed scope 之外，防止等待自身。
- **当前事实与结局分开。**
  phase-1.md 第 155–160、240–243、284–296 行。迟到 exit 先释放执行 lease，并更新当前事实；host
  finalizer 的原始结果独立，immutable Stuck outcome 不改写。
- **预算校验一致。**
  phase-1.md 第 325、346–347 行要求试运行和恢复试运行都计入总预算；初始注册复用同一校验，不再保留较宽松的重复路径。

没有发现需要改动规格的冲突；没有绕过两份 Effect 上游缺口。

## 失败与中断记录

以下包括预期的红测试与开发中的失败检查，不把这些批次计作最终通过证据。日志保存在本地忽略目录
`.cache/review-*.log`。

| 检查                    | 结果与处理                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 红测试               | calls 为 1 而非 0；修复后通过，连同既有 Restart/排队测试共 10 项。                                                                                                              |
| F2 红测试               | provider 得到 Busy；改 shared read 后通过。首次绿批次及两次类型检查还发现夹具误用了 Handle 上不存在的 outcome/status；改用 Change.get 后，17 项与 typecheck 通过。              |
| F3 红测试               | 正常可恢复目标得到 RecoveryFailed；修复授权后增加旧目标撤权和恢复期授权变化测试。                                                                                               |
| F3 初次实现检查         | typecheck 拒绝 failCause 导致的 unknown error channel，以及新增 evidence 的 phase 字符串扩宽；分别改为显式 Cause 值错误和 Evidence 类型参数。                                   |
| F3 时钟夹具             | 过早推进时钟使清理期限先到，得到 Stuck；改为由恢复 Trial 事件和结局竞争同步，再推进 TestClock，26 项通过。                                                                      |
| F4 红测试               | 冗余清理阻塞时 duplicate 未返回；失败清理分支也红。修复后 16 项和 typecheck 通过。                                                                                              |
| F5 红测试               | 连续三次 disposal 后 scope 为 Open；修复及迟到结算补充后 14 项和 typecheck 通过。                                                                                               |
| F6 红测试               | reservation 已释放但 leaseHolders 仍为 [1]；修复后完整 core 869 项通过。                                                                                                        |
| F6 初次实现检查         | Array.filterMap 误用了 Option（本版本要求 Result），且 awaitLateExit 漏声明 DriverError；修正后类型与测试通过。                                                                 |
| 共享 close 红测试       | 首次测试括号错误使格式入口和 vitest 解析失败；修正后确认因缺少模块而红。                                                                                                        |
| 共享 close 首次实现     | metadata cleanup 重名和循环推断导致 typecheck 及 core 失败；明确 AsyncClose.Close 类型、重命名后完整 core 872 项通过。                                                          |
| 预算红测试              | 初始注册接受 Change 已拒绝的两次 trial 预算；统一后 core/release 898 项通过，release 不变量测试随后单独通过。                                                                   |
| 操作提取首次检查        | 机械提取误取分配失败代码的起点，导致格式入口、typecheck、core 解析失败；只修正该提取后完整 core 873 项和 typecheck 通过。                                                       |
| 未准入注册 scope 红测试 | 重复拒绝后 parent finalizer 数量增加；修复后通过。两次 typecheck 暴露测试遗漏 Scope.Empty 分支（第一次文字替换未命中），补齐后通过。                                            |
| 最终 typecheck 首批     | 与全量 test 的 public-api setup 重叠；该 setup 运行 build 并清理 dist，导致 benchmarks 找不到 @graftland/graft 声明及后续级联错误。不计作通过；全量 test 结束后单独重跑已通过。 |

本轮主动中断了一次额外打包检查：已完成规定的 build/test/typecheck 后，我启动既有
`scripts/packed-gateway.mjs test`，没有先重新核对本轮更严格的禁止规则。随后阅读脚本确认它在系统临时目录编译 sample，违反本轮“禁止临时目录构建”的要求；我立即终止了自己启动的进程树（退出码 143），并验证 sample 源文件后删除该次创建的
`/tmp/graft-gateway-0PaXVG`。没有建立回连其他工作区的软链。这次检查不计作通过，也没有改变已完成的规定检查结果。该操作是我的执行疏漏，不是规格解释或规则例外。

## 最终检查

| 检查               | 结果                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`   | 单独最终重跑通过；最初与 test 构建重叠的失败批次见上表。                                                                         |
| `pnpm build`       | 通过，包含 92 个公开入口的 TypeDoc 校验、文档站内链接和 2,662 页三语文档构建。                                                   |
| `pnpm test`        | 323 个文件通过、2 个 benchmarks 文件失败；2,402 项通过、46 项跳过、2 项失败。仅有下列明确允许忽略的 macOS 已知失败，无新增失败。 |
| 打包网关证明       | 因临时目录编译违反本轮规则而主动中断，不作为证据；本轮未重新取得打包证明。                                                       |
| treefmt 与差异检查 | 通过；最后再次运行无格式变化，git diff --check 通过。                                                                            |

两项已知失败：

- benchmarks `test/remote.test.ts`：checks identical work, lifecycle counts and
  native exits for every connection；Unix 路径 `/proc/self/fd/.../runner.sock`
  在 macOS 不可用。
- benchmarks `test/runner.test.ts`：resolves compressed sample files relative to
  nested result outputs；进程审计读取 `/proc` 得到 ENOENT。

上述失败按本轮指示保留且忽略，没有修改 benchmarks 或跳过其测试。
