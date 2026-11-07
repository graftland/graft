# 阶段 1 第二轮审查修复

基线是
`f6ec5bf`。本轮先完成 frozen-lockfile 安装和基线 build，完整阅读独立审查报告，逐项以永久测试复现 F1–F6，再分别提交。五个临时复现已迁入正式测试文件，`review-phase1-probes.test.ts`
已删除。

## Finding 与提交

| Finding               | 提交      | 一句话根因与修复                                                                                                                                                                       |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1                    | `68b6956` | managed scope 的 finalizer 向已经关闭的同一 scope fork 清理，Running 没有执行者；shutdown 改用同步取得所有权的 dispose，异步 close 只在执行者内 claim，并保留原始 Exit。               |
| F2                    | `6eb4e90` | 准入前调用方中断绕过 preparation 的失败清理续体；元数据获取和准入交接共用受保护边界，所有未准入失败退出都启动清理。                                                                    |
| F3                    | `055dc12` | timeout 直接作用于不可中断的准备，连协调器也在等待中断完成；改为对运行时拥有的 fiber 结果设置等待期限，迟到结果和 cause 仍有所有者。                                                   |
| F3 并发 shutdown 补充 | `30dc737` | 父 scope 已开始关闭时，再次 close 子 scope 不能证明准备已退出；用一次性 Deferred 交接实际 fiber，清理等待其原始 Exit，由运行时专有 cleanup scope 承担执行，并在 drain 后关闭该 scope。 |
| F4                    | `120a3df` | 拒绝或准备失败后的慢清理没有结果观察者，原始记录移除后 cause 丢失；原 close 所有者在移除 pending 前调用共享观察 helper，记录完整 cause、实例和请求关联，重复提交也复用此路径。         |
| F5                    | `20cf2ee` | 当前实际成员事实只在结局发布时推导，trial 和路由变化仍保留准入快照；同一 facts 推导用于 get、事件和结局生成，路由/版本/退出更新当前事实，outcome 保持不可变。                          |
| F6                    | `7a18051` | docs 独立测试的根导出预期遗漏 Change；补齐导出契约，并通过真实 TypeDoc 管线检查 Change 请求、handle、状态与拒绝字段。                                                                  |

所有提交均使用 Conventional
Commits 和规定的 Co-Authored-By。未执行 push、rebase、stash、reset、gh 或对外动作；未直接执行任何 packed 脚本。规定的 pnpm
build 中既有 packed-gateway check 按本轮授权运行。

## 证明测试名

| Finding       | 文件                                            | 永久测试名                                                                                       |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F1            | `packages/core/test/change-shutdown.test.ts`    | starts pending cleanup when invoked from its closing owner finalizer                             |
| F1            | 同上                                            | closes a Stuck runtime without exit evidence and completes pending host cleanup                  |
| F1            | 同上                                            | closes a Stuck runtime without exit evidence and retains the original host cleanup failure       |
| F2            | `packages/core/test/change-preparation.test.ts` | cancelling submission releases its metadata preparation                                          |
| F2            | 同上                                            | returns cancelled submission while the runtime still owns slow metadata cleanup                  |
| F3            | 同上                                            | metadata preparation respects its startup deadline                                               |
| F3            | 同上                                            | cleans both early and late resources only after timed-out preparation execution ends             |
| F3            | 同上                                            | retains a late uninterruptible preparation failure and cleans its resources after execution ends |
| F3 补充       | 同上                                            | keeps timed-out preparation resources until actual fiber exit while the runtime is closing       |
| F3 补充       | 同上                                            | releases runtime cleanup ownership after settled preparations and shutdown                       |
| F4            | 同上                                            | late metadata cleanup failures after rejection remain observable                                 |
| F4            | 同上                                            | logs the complete late cleanup cause after preparation failure with request correlation          |
| F4            | 同上                                            | logs the complete late cleanup cause after submission cancellation with request correlation      |
| F4 既有回归   | 同上                                            | logs the full late failure of redundant preparation cleanup after returning the duplicate handle |
| F5            | `packages/core/test/change-settlement.test.ts`  | live trial status reports the committed route and version                                        |
| F5            | 同上                                            | refreshes availability after an accepted generation exits without rewriting its outcome snapshot |
| F5            | 同上                                            | reports an unavailable current route while Restart waits for candidate readiness                 |
| F6            | `packages/docs/reference.test.mjs`              | preserves core exports, re-exports, overloads, and local Schema fields                           |
| F6 新增子测试 | 同上                                            | preserves Change requests, handles, current status, and rejection reference fields               |

F1 的两个运行时测试确实关闭整个 Graft，并始终不给旧 Unit 的 exit
Deferred 发信号，不以关闭实例 scope 冒充运行时关闭。原始 Stuck 结局保持不变，runtime
close 如实返回未确认执行或清理失败。

F3 的并发测试先让 runtime 进入关闭，再推进 startup/terminate 等待期限；提交须先返回，资源必须等实际 fiber 结束后才清理。红测试观测到了提前 cleanup，补充修复后通过。Deferred 仅承担一次性的 fiber 所有权交接，执行结局仍由原 fiber 保留，没有模拟协议。

F5 同时验证 stream 事件和 get 的 trial 事实、Restart 的不可用窗口，以及 Accepted 后的执行退出；结局成员仍保留原服务代和健康状态。

## 惯用法

`23a94b6` 完成两项低优先级调整，没有拒绝项：

- 删除 run.reply 及对应的完成写入；实例退出与外部 handle 都等待同一个已原子发布的 Status.outcome。没有把 STM 发布换成非事务性的 Deferred 通知。
- 从 changeExecution.execute 提出 prepareCandidate、observeTrial、retirePrevious、settleCandidate、recover，明确输入和 Effect 结果；保留原策略和取消边界，没有重写旁路引擎。

清理仍共用原始 Exit 的单所有者异步 close。没有关闭诊断、引入类型断言或修改 Release.close 的中断归因语义。

## 规格解释与证据边界

A 指 design/architecture.md，P 指 design/phase-1.md，行号按本轮基线：

- **shutdown 清理与退出证据独立**：A:214、218–220；P:73–80、146–153、195–197。宿主清理完成不把未确认 Unit 改成已退出，也不改写 Stuck；原 close 及实际 fiber
  Exit 是证据。
- **未准入资源必须结算**：A:214；P:137–139。调用方中断不转移成永久的无主资源；准入成功后的资源才交给 Change。
- **期限限制协调器等待**：A:370；P:46–50。准备运行在拥有它的运行时 fiber 上，超时不代表执行已停止，不能提前清理仍在使用的资源。运行时 cleanup
  scope 直到其义务 drain 后才关闭。
- **迟到 cause 可观察**：A:214、566；P:76–80、92、295–296。完整失败由 runtime-owned
  close 的 completion
  callback 记录，先记录再移除 pending，避免等待观察者被 shutdown 中断。
- **当前实际事实与结局快照分开**：A:559–566；P:82–94、155–160、284–292。get 直接从该记录的真实 route/version
  cells 读取当前事实；路由、可用性变化的事件使用同一推导。outcome 中的成员不随当前事实变动。
- **docs 测试独立验收**：P:357–362。根 pnpm
  test 不等于 docs 包的 Node/TypeDoc/Vitest 测试，本轮单独运行后者。

未修改规格。proof 的运行时关闭映射已改成真实新测试及其边界；2,772 次提交交错仍是模型证据，没有冒充真实穷举。没有新增完整跨单元确认、成员闭包或 supervisor 证明，也没有绕过 design/upstream 的缺口。

## 失败及中断记录

以下保留预期红测试和开发失败，不计作最终通过批次。日志在本地忽略目录 .cache/review2-*.log，基线 build 日志在 /tmp/graft-review2-initial-build.log。

| 检查                     | 失败与处理                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初次环境入口             | install 前 devenv 自动 treefmt 因依赖尚未安装报错；install 最终退出 0。一次 cache DB lock 超时、一次 GC root 读取入口失败，后续串行入口正常。                                         |
| F1 红测试                | 小测试发现 Running 未完成；两个真实 runtime-close 测试触发 3s test timeout 和 10s hook timeout。曾准备停止挂起进程，但查找时测试已自行退出 1，没有实际终止进程。修复后相关 9 项通过。 |
| F2 首次迁移红测试        | 测试缺 RuntimeContext/HashSet 导入，补齐后重新确认实际资源泄漏。                                                                                                                      |
| F2 类型检查              | interruption 分支泄漏 DriverError/TimeoutError 类型，日志 Correlation 缺 index signature；映射 typed rejection 并展开注解记录后通过。                                                 |
| F3 红测试                | 不可中断准备超出 startup 100 倍仍未返回；修复后 deadline 测试通过。                                                                                                                   |
| F3 初次类型检查          | 嵌套 Exit 的泛型联合不匹配；改为 join 的原始结果。新增日志断言先触发 preferEffectString，首次文字替换未命中而多报 unused String；采用正确 Effect String API 后通过。                  |
| F3 完整 core 中间批次    | 误把尚未迁出的临时审查文件一并运行，仅未修复的 F4/F5 两项失败，永久测试通过；后续迁移完成删除该文件。                                                                                 |
| 文档编辑                 | 数次编辑定位断言因自动换行未命中而失败；改用空白兼容定位后完成，最终三语文档测试验证。                                                                                                |
| F4 红测试/类型检查       | 拒绝后晚到清理失败无日志；修复后补充 failure/cancellation 完整 cause 与关联测试。类型检查曾拒绝 Record 字段的点访问，改为索引访问。                                                   |
| F5 红测试/类型检查       | trial 状态仍为旧代；新内部导入与公开 Settlement 接口同名，改名 ChangeFacts，并移除 yield-in-call-argument 写法后通过。                                                                |
| F6 docs 红测试           | Node 阶段 23 通过、1 失败，根导出遗漏 Change，Vitest 未运行；补齐后 25 个 Node 测试和 41 个 Vitest 测试通过。                                                                         |
| 惯用法类型检查           | helper 中两个 yield-in-call-argument 诊断；拆成显式结果变量后通过。                                                                                                                   |
| 并发 shutdown 补充红测试 | 准备尚未结束，cleanup 已发生；改为等待实际 fiber Exit。                                                                                                                               |
| 补充实现初次检查         | 误以为 Effect 4 Fiber.interrupt 返回 Exit（实际返回 void），typecheck 和 core 批次失败，14 项失败/875 项通过；改用 Fiber.await 后相关测试及完整 core 890 项通过。                     |

本轮没有主动中断检查，也没有直接运行 packed 脚本。

## 最终检查

| 检查                    | 真实结果                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| frozen-lockfile install | 通过，退出 0；依赖安装前的自动格式入口错误见上表。                                                                |
| 基线 pnpm build         | 通过；包含本轮明确允许的构建内 packed-gateway check。                                                             |
| 最终 pnpm typecheck     | 通过，先完成再启动根测试，没有与其 public-api build 重叠。                                                        |
| 最终 pnpm build         | 通过；TypeDoc 校验 92 个公开入口，构建 2,662 页文档并检查站内链接。                                               |
| 最终 pnpm test          | 324 个文件通过、2 个 benchmarks 文件失败；2,418 项通过、46 项跳过、2 项失败。仅为下列已知允许例外，没有新增失败。 |
| 最终 docs package test  | 通过：Node/TypeDoc 测试 25 项，Vitest 21 个文件/41 项；两阶段均已实际执行。                                       |
| treefmt --no-cache      | 通过；完整扫描后没有额外格式变化，提交后再次确认工作区无 diff。                                                   |

两项保留且按指示忽略的已知失败：

- benchmarks test/remote.test.ts：checks identical work, lifecycle counts and
  native exits for every
  connection；macOS 不能监听 /proc/self/fd/.../runner.sock。
- benchmarks test/runner.test.ts：resolves compressed sample files relative to
  nested result outputs；macOS 不存在 /proc 进程审计目录。

代码修复和三语文档均已完成；未直接重新运行 packed 运行时证明，由负责人执行。
