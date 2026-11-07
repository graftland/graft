# 阶段 1 第四轮审查修复

基线为
`792f67f`。完整阅读 astra-review4.md 后，先统一终结算结构，再修正执行要求、预算与撤回覆盖。五个 probes 已全部迁入永久测试，`review-phase1-probes.test.ts`
已删除。本轮未直接运行 packed 脚本，未 push、rebase、stash、reset、运行 gh 或对外发布。

## 提交与根因

| 内容             | 提交      | 根因及修复                                                                                                                                                      |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一结构、F1、F4 | `e89e6a7` | 各分支只看局部清理结果，遗漏上一代义务，且把已完成失败当成未解决；Change 现在保留所有代的原始 lease 引用，由统一 Classification/Snapshot 决定结局、保留与释放。 |
| F2               | `8d1504c` | 恢复读取正向 Change 的 Overlap 策略；启动改为显式接收该次执行的 Exclusive/Overlap 要求，恢复和初始注册使用 Exclusive。                                          |
| F3               | `4d45aaa` | 准备清理既未预留，也获得独立的新 terminate 时间；统一 derive 预留准备清理，并以原始 monotonic deadline 限制其等待。                                             |
| F5               | `6f8e2d7` | 原测试只构造图，没有实际撤回；现在真实发布、撤回并保持旧代捕获的 provider lease，经实际 Graft.provide 验证循环拒绝直至结算。                                    |
| 自检补充         | `f58ec66` | 迟到结算重新按当前路由划分旧 Change 的义务，且其 terminate 命令绕过资源执行组；现在固定终结时的所有权边界，迟到命令也进入原执行组。                             |

F1 与 F4 是同一个结构性改变的两处后果，因此在第一个逻辑提交中一起修复，均先取得永久红测试。没有为两个分支各补一份分类判断。

## 永久证明测试

| Finding  | packages/core/test/ 下的文件    | 测试名                                                                                               |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1       | change-terminal.test.ts         | retains recovery reservations until the previous generation has exit evidence                        |
| F1       | 同上                            | retains recovery reservations until previous host cleanup completes                                  |
| F4       | 同上                            | handles a completed preparation cleanup defect as failure rather than unresolved settlement          |
| 分类矩阵 | terminal-settlement.test.ts     | classifies pending cleanup from its original completion evidence                                     |
| 分类矩阵 | 同上                            | classifies running cleanup from its original completion evidence                                     |
| 分类矩阵 | 同上                            | classifies successful original cleanup exit from its original completion evidence                    |
| 分类矩阵 | 同上                            | classifies completed cleanup failure from its original completion evidence                           |
| 分类矩阵 | 同上                            | classifies unattributed cleanup interruption from its original completion evidence                   |
| 分类矩阵 | 同上                            | retains all known failure causes while unresolved ownership takes precedence                         |
| F2       | change-recovery-overlap.test.ts | recovers a Restart-only previous target after an Overlap trial fails                                 |
| F3       | change-total-budget.test.ts     | charges preparation cleanup to the same absolute Change deadline                                     |
| F3       | 同上                            | rejects a total budget that omits the required metadata cleanup reserve                              |
| F3       | 同上                            | caps cleanup waiting at the original absolute deadline even when its operation budget is larger      |
| F5       | generation-ownership.test.ts    | rejects publication cycles through a withdrawn generation until its captured lease settles           |
| 自检补充 | change-late-obligations.test.ts | keeps transferred serving ownership separate when late metadata cleanup settles after execution exit |
| 自检补充 | 同上                            | waits for a late termination command executor before releasing its host resources                    |

F1 两条均验证：义务释放前返回 Stuck，同实例再次提交 Busy，不提前归档；真实退出/清理到达后才释放和归档，重复 await 仍返回同一 Stuck 对象。F4 检查准备 cleanup 为 Failed、完整 cause 保留，恢复结果为 Recovered。

F3 原红测试重现 1,403ms 预算在 1,487ms 返回。补上准备清理预留后，该旧预算会被 InvalidBudget 拒绝；补足后的 1,503ms 场景在总期限内返回。原始清理所有者保持不变，等待到期只影响协调器的等待。

F5 是覆盖缺口，不声称发现生产循环检测缺陷。新测试在当前生产实现上通过；临时让 withdraw 错误清空旧代 captured
provisions 时，新测试失败，证明它能捕获旧测试遗漏的回归。变异已完全撤销，activation.ts 无提交 diff。撤回可以停止旧激活的响应式 watch；测试保留的是旧代实际捕获的 provider
lease，通过该 provider 的活 watch 与 parent/child 边形成循环。

## 统一终结算结构

terminalSettlement.ts 提供唯一的 Classification：

| 分类       | 原始证据                                                       |
| ---------- | -------------------------------------------------------------- |
| Settled    | 有退出证据，且原始清理 Exit 成功。                             |
| Failed     | 清理已经完成，原始 Exit 含已知的非纯中断失败，保留完整 cause。 |
| Unresolved | 缺少退出证据，或清理 Pending/Running/未知/纯中断。             |

聚合优先级为 Unresolved、Failed、Settled；所有失败原因保留。未退出的分配也在同一原始 lease 注册表内，不能因为尚未形成 Attempt 而漏掉。已完成并从 managed.leases 移除的代仍在 Change 的义务记录中。

继续服务的代在终结时移交给注册，不要求为了结算 Change 而终止服务。Snapshot 固定其 generation
token，迟到处理不根据未来路由重新划分所有权。开始停止之前的 drain 仍允许取消并保留旧服务；停止边界后才标记 retiring。退役等待已耗尽时不重新领取整段等待预算；该处 failure
reason 只决定是否再尝试恢复等待，不决定结局或释放。最终是否 Stuck 仍只读全部义务的统一分类。

Unit 的 Termination.cause 是退出诊断，不能仅因字段存在就把成功退出当成失败（Remote 的正常退出也可携带退出状态）。退出证据与原始宿主清理 Exit 分开读取，二者的完整证据仍进入观察事实。

执行与恢复已提取为具备明确输入/输出的 forward、stop、recover、terminal 等操作。transition.ts 的 active-Change 查找只保留一个 helper；没有重写其余引擎闭包，没有关闭诊断、引入类型断言或替换原 AsyncClose 的单所有者 Exit 语义。

## 路径审计

审计覆盖生产代码；测试模型中的 Outcome 构造不充当生产证据。行号按本轮最终实现。

### 预留释放、pending 移除与归档

| 路径                                    | 为什么正确                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| changeTable.ts:244 release（私有）      | 仅由 retire 调用；Capacity claim 释放幂等，writer 按 Change id 比较后才清除，reader 只删除本 id。                                                                                  |
| changeTable.ts:281 archive（私有）      | 仅由 retire 调用；只淘汰已结算历史，keyed 记录仍保留原引用。                                                                                                                       |
| changeTable.ts:296 retire               | 唯一释放/归档守卫；Classification.Unresolved 立即返回 false，其余表示没有未解决义务。                                                                                              |
| changeTable.ts:266 finish               | 发布不可变结局后调用同一 retire；不再凭 outcome 标签猜测是否可以释放。                                                                                                             |
| changeCoordinator.ts:193 work           | 使用最终 Snapshot.state 调用 finish；只有返回 released=true 才移除 managed.pending。Unresolved 一定安装 runtime-owned lateSettlement。                                             |
| changeCoordinator.ts:112 lateSettlement | 遍历终结 Snapshot 中全部未解决义务，等待原始退出与宿主清理，再等待原始准备清理；用固定的 serving 移交边界重新分类，只有 retire=true 才移除 pending。只更新事实，不改写原 outcome。 |
| changeAdmission 准入失败                | STM 预留失败整体回滚；没有已准入 Change 需要外部提前释放。metadata 仍由原运行时清理所有者结算。                                                                                    |
| 容量 end 与 Generations.settle          | 不是冲突预留释放。由确认 Unit exit 或等待实际 allocation fiber Exit 的 finishAllocation 触发；不以 deadline/disposal 作为退出证据。                                                |
| registrationSettled/releaseRegistration | Closed、managed leases 为空、pending 为空才释放注册；仍比较当前索引中的注册对象身份。旧 Change 的迟到处理不会取得同名新注册的 lease。                                              |
| 取消 handle/等待者                      | cancel 只置请求位；取消 await 不释放 Change 义务或预留，执行所有者仍属于 runtime。                                                                                                 |

自检发现并修复了两处边界：若元数据清理迟到时原 serving 代已经退出，旧实现会把其注册清理重新纳入旧 Change，并遗漏新的 watcher，导致预留永久保留；Snapshot 现固定移交边界。另一个是迟到 terminate 命令未受资源执行组管理，退出报告后仍可能使用已经清理的宿主资源；该命令现进入原 executor
group。

### 所有结局标签选择

| 路径                            | 为什么正确                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| changeExecution.ts:122 terminal | 唯一 ExecutionOutcome 构造点。任一 Unresolved 只构造 Stuck；Failed 不能直接成为 Accepted，且保留全部 cause。                      |
| forward:319 正常完成            | 先完成策略、trial、旧代退役，再 terminal。若得到已知 Failed，转 stop 的失败/恢复流程；暂存的非成功结果不发布。                    |
| execute:400 提前关闭/取消       | 只进入 stop，不在入口猜结局；保留中断阶段。                                                                                       |
| stop:261 未解决候选/已耗尽退役  | 只提出 RecoveryFailed 的非成功方向；terminal 读取全部义务决定 Stuck，不根据局部 candidate 结果释放。                              |
| stop:271 shutdown               | 先尝试旧代退役并关闭路由，再统一 terminal；旧代或清理仍未解决必为 Stuck。                                                         |
| stop:283 保留旧服务             | 只有 oldChanged=false 且当前授权/旧代健康检查成功，才提出 Aborted；候选、分配或准备仍未解决时 terminal 仍改为 Stuck。             |
| stop:291 恢复成功               | 完成 fresh metadata/binding、授权、Exclusive 启动、cutover 和完整 trial 后才提出 Recovered；仍经过所有义务分类。                  |
| stop:298 恢复失败               | 结算恢复候选并关闭路由，再 terminal。上一代、正向候选、恢复代、准备均保留在原始记录中，F1 不再只看最后一次 candidate settlement。 |
| emergency:433                   | 尽力终止原义务注册表中的已分配单元，保留全部缺陷 cause；仍调用同一 terminal，尚未退出的 allocation 也会成为 Stuck。               |
| changeCoordinator.publicOutcome | 仅按已定内部标签构造公开 Schema 数据和不可变成员快照，不另做终结算判断。                                                          |
| lateSettlement                  | 不选择新标签，不将原 Stuck 改成 Accepted/Aborted；只在统一分类不再 Unresolved 后释放原预留。                                      |

### 所有 Change strategy 读取

| 路径                            | 为什么正确                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| changeRequest.ts:57 normalize   | 保留策略为规范化请求身份的一部分，用于 key equality；不选择执行或恢复结局。                            |
| changeAdmission.ts:228 选择策略 | 使用准备验证的能力声明选择正向 Overlap/Restart，拒绝不支持的显式 Overlap；同一局部值用于策略容量峰值。 |
| changeExecution.ts:323 forward  | 读取一次已准入策略，只决定正向顺序及传给 start 的本次 Overlap/Exclusive 要求。                         |
| transition.start                | 不再读取 Change.strategy，只校验显式传入的本次执行要求及实际 description。                             |
| recover 与初始注册              | Exclusive；恢复先完成旧代退役，不能继承正向的 Overlap 要求。                                           |

## 规格解释与边界

P 指 design/phase-1.md，A 指 design/architecture.md。本轮未改规格。

- P:67–80、115–121、151–163：缺少结算证据才是 Stuck；预留与记录不能随局部失败分支提前消失。已完成缺陷进入失败/恢复，完整 cause 留存。
- P:192–206、A:409–410：恢复针对上一期望目标，重新获取 binding/授权并满足 Serving；退役后独占启动无须 Overlap 声明。
- P:46–50、352–353、A:370：total 覆盖准备清理，期限限制协调器等待，不能结束原执行/清理所有者或伪造成功。
- P:155–160、222–227：继续服务的代属于长期注册；终结时的移交边界固定，原 Change 不接管未来注册的结算。
- P:237–243、323、348–351：循环检查覆盖撤回后仍保留的实际代租约与 parent/child 路径，必须由生产发布与撤回驱动验证。

未扩大到远端调用完成、完整成员闭包、supervisor 或持久化协议；未绕过 design/upstream 的 Effect 缺口。不可中断执行器若永不退出，协调器可有界报告 Stuck，但运行时关闭可能继续等待真实执行结束。

## 失败与中断记录

日志位于本地忽略目录 .cache/review4-*.log。以下包含预期红测试和开发失败，不冒充最终全绿。

| 批次                    | 失败及处理                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1/F4 永久红测试        | 3 项失败：两个 RecoveryFailed 提前释放，以及完成缺陷被标为 Stuck。                                                                                                                                                                         |
| 结构初版 typecheck      | 两处 yield-in-call-argument、Evidence.phase 被推宽为 string、迁移测试未使用导入；改为显式中间值和泛型 Evidence。                                                                                                                           |
| 结构初版运行            | 2 项失败/1 通过：尚未退役的 previous 被当作阻塞恢复的终义务，导致 timeout；另一个 fixture 把相同失败 finalizer 也加给恢复目标，runtime close 如实报 CleanupError。改正退役边界，并将 F4 输入限定在正向候选以隔离该缺陷，仍断言完整 cause。 |
| 分类矩阵 typecheck      | 清理 Exit 的 E 应为 never，测试误用 Cause.fail；改用两个 Cause.die 验证完整缺陷原因。                                                                                                                                                      |
| 结构完整 core 中间批次  | 898 通过、2 失败：retiring 标记早于停止边界，取消 drain 被错误阻挡；移到 stop 边界。                                                                                                                                                       |
| 结构下一批次            | 旧退役已超时时重复领取等待，退出、清理、dispose 与独立性路径的旧测试 timeout；保留尚未尝试旧退役的恢复机会，耗尽的退役直接进入统一终判断。最终 906 项通过。                                                                                |
| F2 永久红测试           | 恢复 Restart-only 目标得到 RecoveryFailed/IncompatibleContract。                                                                                                                                                                           |
| F2 初次 typecheck       | forward 少传新执行要求参数；补齐后 core 907 项通过。                                                                                                                                                                                       |
| F3 永久红测试           | 1,403ms 请求在 1,487ms 才返回。                                                                                                                                                                                                            |
| F3 完整 core 中间批次   | 908 通过、2 失败：预算公式测试未计 preparation，1450ms 的旧 fixture 已不足新预留，等待 Starting 超时；更新公式断言及 fixture 总预算到 1550ms，仍验证只等待剩余 50ms。最终 910 项通过。                                                     |
| F5 回归变异红测试       | 新测试捕获 withdraw 丢失 captured provisions，1 失败/2 通过。变异不属于生产修复。                                                                                                                                                          |
| F5 变异恢复/中间批次    | 首次替换未命中格式化后的代码，误启动全量变异批次；发现后完整恢复 activation.ts，确认零 diff。该无效批次以 SIGINT 停止（退出 130）。中间日志被两个批次共用，不能作为通过证据；之后串行重跑独立 clean-core 日志。                            |
| F5 typecheck            | 两个 Context key 不符合 deterministicKeys；改为文件限定 key。干净 core 910 项通过。                                                                                                                                                        |
| 自检首次红/类型检查     | serving 转移测试捕获预留未释放；command fixture 误用不存在的 TxRef.updateAndGet，触发 typecheck 和 test/hook timeout；改为 TxRef.modify，并使用 Effect Array.some。                                                                        |
| 自检第一次实现          | 用 lease 对象身份比较 Attempt 的展开对象，未识别 serving，触发两项 timeout；改用同一原始 generation token。                                                                                                                                |
| 自检有效 command 红测试 | 修正 fixture 后重跑原 raw-command 路径，实测 command 未结束而宿主已 cleaned=true；加入执行组后通过。                                                                                                                                       |

除上述明确记录的 SIGINT 外，没有主动中断检查。临时 probes 全部删除，没有保留诊断禁用或测试跳过。

## 最终检查

| 检查                            | 实际结果                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| 每个逻辑修复前的 typecheck/core | 修正后均通过；结构 906、F2 907、F3/F5 910、自检 912 项。                                        |
| 最终 pnpm typecheck             | 通过，退出 0。                                                                                  |
| 最终 pnpm build                 | 通过，退出 0；92 个公开入口、2,662 页和站内链接校验通过。                                       |
| 最终 pnpm test                  | 332 个文件通过、2 个 benchmarks 文件失败；2,442 项通过、46 项跳过、2 项失败，仅为指定已知例外。 |
| 独立 docs 包测试                | 通过，退出 0；25 项 Node/TypeDoc、21 个文件/41 项 Vitest。                                      |
| treefmt --no-cache              | 通过；完整无缓存扫描无额外代码格式变化，报告提交后再次确认无 diff。                             |

两项最终根测试失败按指示保留，不记为通过：

- benchmarks/test/remote.test.ts：checks identical work, lifecycle counts and
  native exits for every
  connection；macOS 的 /proc/self/fd/.../runner.sock 不可用。
- benchmarks/test/runner.test.ts：resolves compressed sample files relative to
  nested result outputs；macOS 不存在 /proc 进程目录。

无新增真实阻塞；本轮代码修复与三语文档已完成，完整 packed 运行时证明由负责人执行。
